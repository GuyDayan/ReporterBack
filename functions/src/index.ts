import { setGlobalOptions } from "firebase-functions";
import { onRequest } from "firebase-functions/https";
import * as logger from "firebase-functions/logger";
import admin from "firebase-admin";

import { BaseResponseModel } from "./models/responses/BaseResponseModel";
import { ErrorCodes } from "./enums/ErrorCodes";
import { GeneralUtils } from "./utils/GeneralUtils";
import apiService from "./utils/ApiService";
import { AuthCodeDoc, UserRole } from "./utilities/types";
import { Def } from "./utils/Definitions";
import { SecurityCodeResponseModel } from "./models/responses/SecurityCodeResponseModel";
import { CreateUserResponseModel } from "./models/responses/CreateUserResponseModel";
import { EmployeeModel, ManagerModel, SubcontractorModel } from "./models/objects/users";
import { UidResponseModel } from "./models/responses/UidResponseModel";

setGlobalOptions({ maxInstances: 10 });

const serviceAccount = require("../../service-account.json");

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});
logger.info(
    {
        project: process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT,
        firestoreTarget: process.env.FIRESTORE_EMULATOR_HOST ? `EMULATOR ${process.env.FIRESTORE_EMULATOR_HOST}` : "PRODUCTION",
        authTarget: process.env.FIREBASE_AUTH_EMULATOR_HOST ? `EMULATOR ${process.env.FIREBASE_AUTH_EMULATOR_HOST}` : "PRODUCTION",
        storageTarget:
            process.env.FIREBASE_STORAGE_EMULATOR_HOST || process.env.STORAGE_EMULATOR_HOST ? "EMULATOR" : "PRODUCTION",
    },
    { structuredData: true }
);

const db = admin.firestore();

export const helloWorld = onRequest((request, response) => {
    logger.info("Hello logs!", { structuredData: true });
    response.send("Hello from Firebase!");
});

/**
 * Resolve app user by phone. Accepts any input, normalizes internally.
 * 1) users_index/{digitsOnly} -> { uid } (fast path)
 * 2) fallback: users where phone in [digitsOnly, "+digits"]
 */
async function resolveUserByPhone(input: string): Promise<{ uid: string; role: UserRole } | null> {
    const key = GeneralUtils.normalizePhone(input); // "972546432705"
    const plusKey = `+${key}`;

    // 1) index lookup
    const idxSnap = await db.collection("users_index").doc(key).get();
    if (idxSnap.exists) {
        const uid = (idxSnap.data() || {}).uid as string | undefined;
        if (uid) {
            const userDoc = await db.collection("users").doc(uid).get();
            if (!userDoc.exists) return null;
            const r = userDoc.data()?.role as UserRole;
            return { uid, role:r };
        }
    }

    // 2) fallback query (if older docs stored "+digits")
    const q = await db
        .collection("users")
        .where("phone", "in", [key, plusKey])
        .limit(1)
        .get();

    if (!q.empty) {
        const doc = q.docs[0];
        const r = doc.data()?.role as UserRole;
        const role: UserRole =
            r === "manager" || r === "employee" || r === "contractor" ? r : "employee";
        return { uid: doc.id, role };
    }

    return null;
}

/** ------------------ Login: send code ------------------ */
export const login = onRequest(async (request, response) => {
    const baseResponse = new BaseResponseModel();
    try {
        const body = request.body || {};
        const rawPhone = body.phoneNumber || body.phone; // accept both

        if (!rawPhone) {
            baseResponse.errorCode = ErrorCodes.MISSING_PARAMS;
        } else {
            const docKey = GeneralUtils.normalizePhone(rawPhone); // digits only -> authCodes/{docKey}
            const e164   = GeneralUtils.toE164(rawPhone);         // "+972..."

            const now    = admin.firestore.Timestamp.now();
            const docRef = db.collection("authCodes").doc(docKey);
            const snap   = await docRef.get();

            if (snap.exists) {
                const data = snap.data() as AuthCodeDoc;

                // expired -> new code (reset attempts)
                if (now.toMillis() > data.expiresAt.toMillis()) {
                    const sent = await generateAndSendCode({ docKey, e164, docRef, now });
                    baseResponse.success = !!sent;
                    if (!sent) baseResponse.errorCode = ErrorCodes.FAILED_TO_SEND_CODE;
                } else {
                    // not expired -> apply resend cooldown
                    const secsSinceLast = now.seconds - data.lastSentAt.seconds;
                    if (secsSinceLast > Def.SEND_COOLDOWN_SEC) {
                        const sent = await generateAndSendCode({ docKey, e164, docRef, now });
                        baseResponse.success = !!sent;
                        if (!sent) baseResponse.errorCode = ErrorCodes.FAILED_TO_SEND_CODE;
                    } else {
                        baseResponse.errorCode = ErrorCodes.TOO_SOON_FOR_RESEND_CODE;
                    }
                }
            } else {
                // first time for this phone
                const sent = await generateAndSendCode({ docKey, e164, docRef, now });
                baseResponse.success = sent;
                if (!sent) baseResponse.errorCode = ErrorCodes.FAILED_TO_SEND_CODE;
            }
        }
    } catch (e) {
        console.error(e);
        baseResponse.errorCode = ErrorCodes.SERVER_ERROR;
    }

    response.json(baseResponse);
});

async function generateAndSendCode(params: {
    docKey: string;
    e164: string;
    docRef: FirebaseFirestore.DocumentReference;
    now: FirebaseFirestore.Timestamp;
}): Promise<boolean> {
    const { docKey, e164, docRef, now } = params;
    const code = GeneralUtils.generateRandomCode(6);
    const expiresAt = admin.firestore.Timestamp.fromMillis(now.toMillis() + Def.CODE_TTL_SEC * 1000);

    await docRef.set(
        {
            codeHash: GeneralUtils.hashCode(docKey, code),
            createdAt: now,
            expiresAt,
            lastSentAt: now,
            attempts: 0,            // reset on each new code
            deleteAfter: expiresAt, // TTL cleanup
        } as AuthCodeDoc,
        { merge: true }
    );
    return await apiService.sendCode(e164, code);
}

export const sendSecurityCode = onRequest(async (request, response) => {
    let baseResponse = new BaseResponseModel();
    try {
        const { phone, code } = request.body || {};
        if (!phone || !code) {
            baseResponse.errorCode = ErrorCodes.MISSING_PARAMS;
        } else {
            const docKey = GeneralUtils.normalizePhone(phone);
            const e164   = GeneralUtils.toE164(phone);
            const now    = admin.firestore.Timestamp.now();
            const docRef = db.collection("authCodes").doc(docKey);
            const snap   = await docRef.get();
            if (!snap.exists) {
                baseResponse.errorCode = ErrorCodes.INVALID_OR_EXPIRED_CODE;
            } else {
                const data = snap.data() as AuthCodeDoc;

                if (now.toMillis() > data.expiresAt.toMillis()) {
                    baseResponse.errorCode = ErrorCodes.INVALID_OR_EXPIRED_CODE;
                } else if ((data.attempts || 0) >= Def.MAX_ATTEMPTS) {
                    baseResponse.errorCode = ErrorCodes.TOO_MANY_ATTEMPTS_LOCKED;
                } else {
                    const providedHash = GeneralUtils.hashCode(docKey, code); // must match /login
                    const isValid = providedHash === data.codeHash;
                    if (!isValid) {
                        const newAttempts = (data.attempts || 0) + 1;
                        await docRef.set({ attempts: newAttempts }, { merge: true });
                        baseResponse.errorCode =
                            newAttempts >= Def.MAX_ATTEMPTS ? ErrorCodes.TOO_MANY_ATTEMPTS_LOCKED : ErrorCodes.INVALID_CODE;
                    } else {
                        await docRef.delete();
                        let userRecord: admin.auth.UserRecord;
                        try {
                            userRecord = await admin.auth().getUserByPhoneNumber(e164);
                        } catch {
                            userRecord = await admin.auth().createUser({ phoneNumber: e164 });
                        }
                        const meta = await resolveUserByPhone(docKey);
                        if (!meta) {
                            baseResponse.errorCode = ErrorCodes.USER_NOT_REGISTERED;
                        } else {
                            const customToken = await admin.auth().createCustomToken(userRecord.uid, { role: meta.role });
                            const ok = new SecurityCodeResponseModel(customToken, userRecord.uid, meta.role);
                            ok.success = true;
                            baseResponse = ok;
                        }
                    }
                }
            }
        }
    } catch (e) {
        console.error(e);
        baseResponse.errorCode = ErrorCodes.SERVER_ERROR;
    }

    response.json(baseResponse);
});

/** ------------------ Create User (superadmin token) ------------------ */
export const createUser = onRequest(async (request, response) => {
    let baseResponse = new BaseResponseModel();
    try {
        const authHeader = (request.headers.authorization || "").toString();
        if (!authHeader) {
            baseResponse.errorCode = ErrorCodes.UNAUTHORIZED;
        } else {
            const staticToken = process.env.SUPERADMIN_TOKEN;
            const isSuperAdmin = !!staticToken && authHeader === staticToken;

            if (!isSuperAdmin) {
                baseResponse.errorCode = ErrorCodes.FORBIDDEN;
            } else {
                const { phoneNumber, firstName, lastName, workerType, managerId, subcontractorId, siteIds } =
                request.body || {};

                if (phoneNumber && firstName && lastName && workerType) {
                    if (workerType === "manager" || workerType === "employee") {
                        const docPhone = GeneralUtils.normalizePhone(phoneNumber); // digits only
                        const e164     = GeneralUtils.toE164(phoneNumber);         // "+972..."

                        // Admin Auth by E.164
                        let userRecord: admin.auth.UserRecord;
                        try {
                            userRecord = await admin.auth().getUserByPhoneNumber(e164);
                        } catch {
                            userRecord = await admin.auth().createUser({ phoneNumber: e164 });
                        }
                        const uid = userRecord.uid;
                        const role = workerType as UserRole;
                        await admin.auth().setCustomUserClaims(uid, { role });
                        if (role === "manager") {
                            const model = new ManagerModel({
                                firstName,
                                lastName,
                                phone: docPhone,
                                siteIds: Array.isArray(siteIds) ? siteIds : [],
                            });
                            await db.collection("users").doc(uid).set({ ...model }, { merge: true });
                        } else {
                            const model = new EmployeeModel({
                                firstName,
                                lastName,
                                phone: docPhone,
                                managerId: typeof managerId === "string" ? managerId : null,
                                subcontractorId: typeof subcontractorId === "string" ? subcontractorId : null,
                            });
                            await db.collection("users").doc(uid).set({ ...model }, { merge: true });
                        }

                        // index: users_index/{digitsOnly} -> { uid }
                        await db.collection("users_index").doc(docPhone).set({ uid }, { merge: true });

                        baseResponse = new CreateUserResponseModel(uid, role);
                        baseResponse.success = true;
                    } else {
                        baseResponse.errorCode = ErrorCodes.INVALID_ROLE;
                    }
                } else {
                    baseResponse.errorCode = ErrorCodes.MISSING_PARAMS;
                }
            }
        }
    } catch (e) {
        console.error(e);
        baseResponse.errorCode = ErrorCodes.SERVER_ERROR;
    }

    response.json(baseResponse);
});

/** ------------------ Create Subcontractor (superadmin token) ------------------ */
export const createSubcontractor = onRequest(async (request, response) => {
    let baseResponse = new BaseResponseModel();
    try {
        const authHeader = (request.headers.authorization || "").toString();
        if (!authHeader) {
            baseResponse.errorCode = ErrorCodes.UNAUTHORIZED;
        } else {
            const staticToken = process.env.SUPERADMIN_TOKEN;
            const isSuperAdmin = !!staticToken && authHeader === staticToken;

            if (!isSuperAdmin) {
                baseResponse.errorCode = ErrorCodes.FORBIDDEN;
            } else {
                const { name, managerIds, phone } = request.body || {};
                if (name && Array.isArray(managerIds) && managerIds.length > 0) {
                    const subcontractor = new SubcontractorModel({
                        name,
                        managerIds,
                        phone: typeof phone === "string" ? phone : null, // store raw; normalize later if needed
                    });

                    const docRef = db.collection("subcontractors").doc();
                    await docRef.set(
                        {
                            ...subcontractor,
                            createdAt: admin.firestore.FieldValue.serverTimestamp(),
                        },
                        { merge: true }
                    );

                    baseResponse = new UidResponseModel(docRef.id);
                    baseResponse.success = true;
                } else {
                    baseResponse.errorCode = ErrorCodes.MISSING_PARAMS;
                }
            }
        }
    } catch (e) {
        console.error(e);
        baseResponse.errorCode = ErrorCodes.SERVER_ERROR;
    }

    response.json(baseResponse);
});
