import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { mockUsersTable } from "@/db/schema";
import type { User } from "@/models/user.model";
import { AppError } from "@/utils";

export const userService = {
  async findAll(): Promise<User[]> {
    return db.select().from(mockUsersTable);
  },

  async findById(id: string): Promise<User> {
    const [user] = await db
      .select()
      .from(mockUsersTable)
      .where(eq(mockUsersTable.id, id));
    if (!user) throw new AppError("NOT_FOUND");

    return user;
  },

  async create(name: string): Promise<User> {
    const [existing] = await db
      .select()
      .from(mockUsersTable)
      .where(eq(mockUsersTable.name, name));
    if (existing) throw new AppError("ALREADY_EXISTS", { name });

    const [user] = await db.insert(mockUsersTable).values({ name }).returning();
    return user;
  },
};
