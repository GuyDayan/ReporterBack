import admin, {firestore} from 'firebase-admin';
import {UserRole} from "../../utilities/types";
import FieldValue = firestore.FieldValue;

export abstract class BaseUserModel {
    firstName: string;
    lastName: string;
    phone: string;                // שמרתי על השם "phone" כמו בקוד שלך
    role: UserRole;
    active: boolean;
    createdAt?: FieldValue

    protected constructor(params: { firstName: string; lastName: string; phone: string; role: UserRole}) {
        this.firstName = params.firstName;
        this.lastName = params.lastName;
        this.phone = params.phone;
        this.role = params.role;
        this.active = true
        this.createdAt = admin.firestore.FieldValue.serverTimestamp()
    }
}

export class ManagerModel extends BaseUserModel {
    siteIds: string[] = [];
    constructor(params: { firstName: string; lastName: string; phone: string ; siteIds?: string[] }) {
        super({ ...params, role: 'manager' });
        this.siteIds = params.siteIds ?? [];
    }
}


export class EmployeeModel extends BaseUserModel {
    managerId?: string | null;
    subcontractorId?: string | null;

    constructor(params: { firstName: string; lastName: string; phone: string; managerId: string|null; subcontractorId?: string | null; }) {
        super({ firstName: params.firstName, lastName: params.lastName, phone: params.phone, role: 'employee' });
        this.managerId = params.managerId;
        this.subcontractorId = params.subcontractorId ?? null;
    }
}

export class SubcontractorModel {
    name: string;
    phone?: string | null;
    managerIds: string[];
    active: boolean;

    constructor(params: { name: string; managerIds: string[]; phone?: string | null }) {
        this.name = params.name;
        this.managerIds = params.managerIds;
        this.phone = params.phone ?? null;
        this.active = true;

    }
}
