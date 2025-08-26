import {BaseResponseModel} from "./BaseResponseModel";

export class SecurityCodeResponseModel extends BaseResponseModel{

    token?: string;
    uid?: string;
    role?: string;


    constructor(token: string, uid: string, role: string) {
        super();
        this.token = token;
        this.uid = uid;
        this.role = role;
    }
}
