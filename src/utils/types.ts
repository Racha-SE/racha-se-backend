import { userTypeEnum } from "@/db/schema/user";

export type UserType = (typeof userTypeEnum.enumValues)[number];
