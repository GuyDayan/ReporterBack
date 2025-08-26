export interface AuthCodeDoc {
    codeHash: string;
    createdAt: FirebaseFirestore.Timestamp;
    expiresAt: FirebaseFirestore.Timestamp;
    lastSentAt: FirebaseFirestore.Timestamp;
    attempts: number;                  // wrong attempts on this code
    deleteAfter: FirebaseFirestore.Timestamp; // == expiresAt (for TTL)
}

export type UserRole = 'manager'  | 'employee';

