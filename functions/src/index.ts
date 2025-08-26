import {setGlobalOptions} from "firebase-functions";
import {onRequest} from "firebase-functions/https";
import * as logger from "firebase-functions/logger";
import admin from 'firebase-admin';
import {BaseResponseModel} from "./models/responses/BaseResponseModel";
import {ErrorCodes} from "./enums/ErrorCodes";
import {GeneralUtils} from "./utils/GeneralUtils";
import apiService from "./utils/ApiService";
import {AuthCodeDoc, UserRole} from "./utilities/types";
import {Def} from "./utils/Definitions";
import {SecurityCodeResponseModel} from "./models/responses/SecurityCodeResponseModel";
import {CreateUserResponseModel} from "./models/responses/CreateUserResponseModel";
import {EmployeeModel, ManagerModel, SubcontractorModel} from "./models/objects/users";
import {UidResponseModel} from "./models/responses/UidResponseModel";

setGlobalOptions({maxInstances: 10});

admin.initializeApp();
logger.info({
    project: process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT,
    firestoreTarget: process.env.FIRESTORE_EMULATOR_HOST ? `EMULATOR ${process.env.FIRESTORE_EMULATOR_HOST}` : 'PRODUCTION',
    authTarget: process.env.FIREBASE_AUTH_EMULATOR_HOST ? `EMULATOR ${process.env.FIREBASE_AUTH_EMULATOR_HOST}` : 'PRODUCTION',
    storageTarget: process.env.FIREBASE_STORAGE_EMULATOR_HOST || process.env.STORAGE_EMULATOR_HOST ? 'EMULATOR' : 'PRODUCTION',
}, { structuredData: true });

const db = admin.firestore();

export const helloWorld = onRequest((request, response) => {
    logger.info("Hello logs!", {structuredData: true});
    response.send("Hello from Firebase!");
});


async function resolveUserByPhone(phoneE164: string): Promise<{ uid: string; role: UserRole } | null> {
    const idxSnap = await db.collection('users_index').doc(phoneE164).get();
    if (idxSnap.exists) {
        const d = idxSnap.data() || {};
        const uid = d.uid as string | undefined;
        if (uid) {
            const userDoc = await db.collection('users').doc(uid).get();
            if (!userDoc.exists) return null;
            const role = (userDoc.data()?.role === 'manager' ? 'manager' : 'employee') as UserRole;
            return { uid, role };
        }
    }
    const usersSnap = await db.collection('users').where('phone', '==', phoneE164).limit(1).get();
    if (!usersSnap.empty) {
        const doc = usersSnap.docs[0];
        const role = (doc.data()?.role === 'manager' ? 'manager' : 'employee') as UserRole;
        return { uid: doc.id, role };
    }
    return null;
}


export const login = onRequest(async (request, response) => {
    const baseResponse = new BaseResponseModel();
    try {
        const body = request.body || {};
        const rawPhone = body.phoneNumber || body.phone;     // accept both
        if (rawPhone) {
            const phone = GeneralUtils.normalizePhone(rawPhone);
            const now = admin.firestore.Timestamp.now();
            const docRef = db.collection("authCodes").doc(phone);
            const snap = await docRef.get();

            if (snap.exists) {
                const data = snap.data() as AuthCodeDoc;

                // If expired -> issue a fresh code (reset attempts)
                if (now.toMillis() > data.expiresAt.toMillis()) {
                    const sent = await generateAndSendCode({ phone, docRef, now });
                    baseResponse.success = sent;
                    if (!sent) baseResponse.errorCode = ErrorCodes.FAILED_TO_SEND_CODE;

                } else {
                    // Not expired -> apply resend cooldown
                    const secsSinceLast = now.seconds - data.lastSentAt.seconds;
                    if (secsSinceLast > Def.SEND_COOLDOWN_SEC) {
                        const sent = await generateAndSendCode({ phone, docRef, now });
                        baseResponse.success = !!sent;
                        if (!sent) baseResponse.errorCode = ErrorCodes.FAILED_TO_SEND_CODE;
                    } else {
                        baseResponse.errorCode = ErrorCodes.TOO_SOON_FOR_RESEND_CODE;
                    }
                }
            } else {
                // First time for this phone – create the doc
                const sent = await generateAndSendCode({ phone, docRef, now });
                baseResponse.success = !!sent;
                if (!sent) baseResponse.errorCode = ErrorCodes.FAILED_TO_SEND_CODE;
            }
        } else {
            baseResponse.errorCode = ErrorCodes.MISSING_PARAMS;
        }
    } catch (e) {
        console.error(e);
        baseResponse.errorCode = ErrorCodes.SERVER_ERROR;
    }

    response.json(baseResponse);
});

async function generateAndSendCode(params: {
    phone: string;
    docRef: FirebaseFirestore.DocumentReference;
    now: FirebaseFirestore.Timestamp;
}): Promise<boolean> {
    const { phone, docRef, now } = params;
    const code = GeneralUtils.generateRandomCode(6);
    const expiresAt = admin.firestore.Timestamp.fromMillis(
        now.toMillis() + Def.CODE_TTL_SEC * 1000
    );
    await docRef.set(
        {
            codeHash: GeneralUtils.hashCode(phone, code),
            createdAt: now,
            expiresAt,
            lastSentAt: now,
            attempts: 0,              // reset on every new code
            deleteAfter: expiresAt,   // for TTL cleanup
        } as AuthCodeDoc,
        { merge: true }
    );

    return await apiService.sendCode(phone, code);
}


/** ---------- Verify code & issue custom token ---------- */

export const sendSecurityCode = onRequest(async (request, response) => {
    let baseResponse = new BaseResponseModel();
    try {
        const { phoneNumber, phone, code } = request.body || {};
        const rawPhone = phoneNumber || phone; // accept both
        if (rawPhone && code) {
            const phoneE164 = GeneralUtils.normalizePhone(rawPhone);
            const now   = admin.firestore.Timestamp.now();
            const docRef = db.collection("authCodes").doc(phoneE164);
            const snap   = await docRef.get();

            if (!snap.exists) {
                baseResponse.errorCode = ErrorCodes.INVALID_OR_EXPIRED_CODE;

            } else {
                const data = snap.data() as AuthCodeDoc;

                // 1) expired?
                if (now.toMillis() > data.expiresAt.toMillis()) {
                    baseResponse.errorCode = ErrorCodes.INVALID_OR_EXPIRED_CODE;

                    // 2) attempts exhausted?
                } else if ((data.attempts || 0) >= Def.MAX_ATTEMPTS) {
                    // keep the same doc; user must request a new code after TTL
                    baseResponse.errorCode = ErrorCodes.TOO_MANY_ATTEMPTS_LOCKED; // or use a simpler code name if you prefer

                } else {
                    // 3) verify
                    const providedHash = GeneralUtils.hashCode(phoneE164, code);
                    const isValid      = providedHash === data.codeHash;

                    if (isValid) {
                        await docRef.delete(); // one-time use

                        // Ensure Auth user exists
                        let userRecord: admin.auth.UserRecord;
                        try {
                            userRecord = await admin.auth().getUserByPhoneNumber(phoneE164);
                        } catch {
                            userRecord = await admin.auth().createUser({ phoneNumber: phoneE164 });
                        }

                        // Only allow admin-created users
                        const meta = await resolveUserByPhone(phoneE164);
                        if (!meta) {
                            baseResponse.errorCode = ErrorCodes.USER_NOT_REGISTERED;

                        } else {
                            await admin.auth().setCustomUserClaims(userRecord.uid, { role: meta.role });
                            const customToken = await admin.auth().createCustomToken(userRecord.uid, { role: meta.role });

                            baseResponse = new SecurityCodeResponseModel(
                                customToken,
                                userRecord.uid,
                                meta.role
                            );
                            baseResponse.success = true;
                        }

                    } else {
                        // wrong code -> increment attempts
                        const newAttempts = (data.attempts || 0) + 1;
                        await docRef.set({ attempts: newAttempts }, { merge: true });
                        baseResponse.errorCode = (newAttempts >= Def.MAX_ATTEMPTS)
                            ? ErrorCodes.TOO_MANY_ATTEMPTS_LOCKED
                            : ErrorCodes.INVALID_CODE;
                    }
                }
            }
        } else {
            baseResponse.errorCode = ErrorCodes.MISSING_PARAMS;
        }
    } catch (e) {
        console.error(e);
        baseResponse.errorCode = ErrorCodes.SERVER_ERROR;
    }

    response.json(baseResponse);
});


export const createUser = onRequest(async (request, response) => {
    let baseResponse = new BaseResponseModel();
    try {
        const authHeader  = (request.headers.authorization || "").toString();

        if (authHeader) {
            const staticToken = process.env.SUPERADMIN_TOKEN;
            let isSuperAdmin = !!staticToken && authHeader === staticToken;

            if (isSuperAdmin) {
                const {
                    phoneNumber,
                    firstName,
                    lastName,
                    workerType,
                    managerId,
                    subcontractorId,
                    siteIds
                } = request.body || {};
                if (phoneNumber && firstName && lastName && workerType) {
                    if (workerType === "manager" || workerType === "employee") {
                        const phone = GeneralUtils.normalizePhone(phoneNumber);
                        let userRecord: admin.auth.UserRecord;
                        try {
                            userRecord = await admin.auth().getUserByPhoneNumber(phone);
                        } catch {
                            userRecord = await admin.auth().createUser({ phoneNumber: phone });
                        }
                        const uid  = userRecord.uid;
                        const role = workerType as UserRole;
                        await admin.auth().setCustomUserClaims(uid, { role });
                        if (role === 'manager') {
                            const model = new ManagerModel({
                                firstName,
                                lastName,
                                phone,
                                siteIds: Array.isArray(siteIds) ? siteIds : [],
                            });
                            await db.collection('users').doc(uid).set({ ...model }, { merge: true });
                        } else {
                            const model = new EmployeeModel({
                                firstName,
                                lastName,
                                phone,
                                managerId: typeof managerId === 'string' ? managerId : null,
                                subcontractorId: typeof subcontractorId === 'string' ? subcontractorId : null,
                            });
                            await db.collection('users').doc(uid).set({ ...model }, { merge: true });
                        }

                        await db.collection('users_index').doc(phone).set({ uid }, { merge: true });
                        baseResponse = new CreateUserResponseModel(uid, role);
                        baseResponse.success = true;
                    } else {
                        baseResponse.errorCode = ErrorCodes.INVALID_ROLE;
                    }
                } else {
                    baseResponse.errorCode = ErrorCodes.MISSING_PARAMS;
                }
            } else {
                baseResponse.errorCode = ErrorCodes.FORBIDDEN;
            }
        } else {
            baseResponse.errorCode = ErrorCodes.UNAUTHORIZED;
        }
    } catch (e) {
        console.error(e);
        baseResponse.errorCode = ErrorCodes.SERVER_ERROR;
    }

    response.json(baseResponse);
});

export const createSubcontractor = onRequest(async (request, response) => {
    let baseResponse = new BaseResponseModel();
    try {
        const authHeader = (request.headers.authorization || "").toString();
        if (authHeader) {
            const staticToken = process.env.SUPERADMIN_TOKEN;
            const isSuperAdmin = !!staticToken && authHeader === staticToken;

            if (isSuperAdmin) {
                const { name, managerIds, phone } = request.body || {};
                if (name && Array.isArray(managerIds) && managerIds.length > 0) {
                    const subcontractor = new SubcontractorModel({
                        name,
                        managerIds,
                        phone: typeof phone === 'string' ? phone : null,
                    });

                    const docRef = db.collection('subcontractors').doc();
                    await docRef.set(
                        {...subcontractor, createdAt: admin.firestore.FieldValue.serverTimestamp(),},
                        { merge: true }
                    );
                    baseResponse = new UidResponseModel(docRef.id);
                    baseResponse.success = true
                } else {
                    baseResponse.errorCode = ErrorCodes.MISSING_PARAMS;
                }
            } else {
                baseResponse.errorCode = ErrorCodes.FORBIDDEN;
            }
        } else {
            baseResponse.errorCode = ErrorCodes.UNAUTHORIZED;
        }
    } catch (e) {
        console.error(e);
        baseResponse.errorCode = ErrorCodes.SERVER_ERROR;
    }

    response.json(baseResponse);
});
