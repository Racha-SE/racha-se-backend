import { AppError } from "../utils/error";

export function endOfBangkokDay(day: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day))
    throw new AppError("VALIDATION", { message: "incorrect expired date" });
  const expiry = new Date(`${day}T23:59:59.999+07:00`);
  if (expiry <= new Date())
    throw new AppError("VALIDATION", { message: "incorrect expired date" });
  return expiry;
}
