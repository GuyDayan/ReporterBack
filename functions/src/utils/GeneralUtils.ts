import * as crypto from "crypto";

export class GeneralUtils {

    private static PEPPER = process.env.CODE_PEPPER || "dev_pepper_change_me";

     static generateRandomCode = (length: number): string => {
        let result = '';
        const characters = '0123456789';
        const charactersLength = characters.length;
        for (let i = 0; i < length; i++) {
            result += characters.charAt(Math.floor(Math.random() * charactersLength));
        }
        return result;
    }


// נירמול טלפון (פשטני; מומלץ ספריה כמו libphonenumber-js)
    static normalizePhone(phone: string,prefix="+972"): string {
        return phone.replace(/\s|-/g, "").replace(/^0/, prefix); // דוגמה לישראל; התאם לצורך
    }

    static hashCode(phoneE164: string, code: string) {
        return crypto.createHmac("sha256", this.PEPPER).update(`${phoneE164}:${code}`).digest("hex");
    }


}
