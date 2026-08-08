import type { User } from "@/models/user.model";
import { AppError } from "@/utils";

// mock in-memory data — replace with a real DB query (drizzle) later
const users: User[] = [
  { id: "1", name: "Narumed" },
  { id: "2", name: "Pitayachamrat" },
];

export const userService = {
  findAll(): User[] {
    return users;
  },

  findById(id: string): User {
    const user = users.find((u) => u.id === id);
    if (!user) throw new AppError("NOT_FOUND");

    return user;
  },

  create(name: string): User {
    const exists = users.some((u) => u.name === name);
    if (exists) throw new AppError("ALREADY_EXISTS", { name });

    const user: User = { id: String(users.length + 1), name };
    users.push(user);

    return user;
  },
};
