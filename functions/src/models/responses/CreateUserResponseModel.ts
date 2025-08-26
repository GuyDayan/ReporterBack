import {BaseResponseModel} from "./BaseResponseModel";
import {UserRole} from "../../utilities/types";

export class CreateUserResponseModel extends BaseResponseModel{

    userUid: string;
    role: UserRole;


    constructor(userUid: string, role: UserRole) {
        super();
        this.userUid = userUid;
        this.role = role;
    }
}
