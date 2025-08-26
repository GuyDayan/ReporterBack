import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import admin from "firebase-admin";

const isEmulator =
    process.env.FUNCTIONS_EMULATOR === 'true' ||
    !!process.env.FIRESTORE_EMULATOR_HOST ||
    !!process.env.FIREBASE_AUTH_EMULATOR_HOST;

export class ApiService {

  async get<T>(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    return axios.get<T>(url, config);
  }
  async post<T>(url: string, data?: any, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    return axios.post<T>(url, data, config);
  }
  async sendCode(phone: string, code:string) {
    if (isEmulator) {
      console.log(`[DEV] SMS to ${phone}: ${code}`);
      await admin
          .firestore()
          .collection('dev_sms')
          .doc(phone)
          .set({ code, sentAt: admin.firestore.FieldValue.serverTimestamp() });
      return true;
    }

    // TODO: call your real SMS provider here in prod
    // return provider.send({ to: phone, text: `Your code: ${code}` });
    return true;
  }

}
const apiService = new ApiService();
export default apiService;
