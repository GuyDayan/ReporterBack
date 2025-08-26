import {BaseResponseModel} from "./BaseResponseModel";

export class UidResponseModel extends BaseResponseModel{

    uid: string;

    constructor(uid: string) {
        super();
        this.uid = uid;
    }
}
