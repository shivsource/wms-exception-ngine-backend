import { RowDataPacket } from 'mysql2';

/** Shorthand for typing mysql2 query results against our own row interfaces. */
export type SqlRow<T> = T & RowDataPacket;
