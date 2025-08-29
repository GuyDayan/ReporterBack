import * as crypto from "crypto";
import {CountryCode, parsePhoneNumberWithError} from "libphonenumber-js";

export class GeneralUtils {
    private static PEPPER = process.env.CODE_PEPPER || "dev_pepper_change_me";

    static generateRandomCode(length: number): string {
        let result = "";
        const digits = "0123456789";
        for (let i = 0; i < length; i++) {
            result += digits.charAt(Math.floor(Math.random() * digits.length));
        }
        return result;
    }
    static toE164(raw: string, defaultCountry: CountryCode = "IL"): string {
        if (!raw) throw new Error("INVALID_PHONE_EMPTY");
        try {
            const p = parsePhoneNumberWithError(String(raw), defaultCountry);
            if (!p || !p.isValid()) throw new Error("INVALID_PHONE_FORMAT");
            return p.number; // E.164 with '+'
        } catch {
            throw new Error("INVALID_PHONE_FORMAT");
        }
    }

    static normalizePhone(raw: string, defaultCountry: CountryCode = "IL"): string {
        const e164 = GeneralUtils.toE164(raw, defaultCountry);
        return e164.replace(/^\+/, "");
    }
    static hashCode(phoneSalt: string, code: string) {
        return crypto
            .createHmac("sha256", this.PEPPER)
            .update(`${phoneSalt}:${code}`)
            .digest("hex");
    }
}
