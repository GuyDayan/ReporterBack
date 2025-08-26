export class BaseResponseModel {

    success: boolean;
    errorCode: number|null;

    constructor() {
        this.success = false;
        this.errorCode = null;
    }
}
