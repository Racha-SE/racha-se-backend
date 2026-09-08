import type { OrdersHqCreateBody } from "@/models/orders-hq.model";

export const ordersHqService = {
  // TODO: once this writes head_order_detail rows for real, resolve the HQ
  // min_stock notification for each product in the order — see
  // notification.service.ts's top comment.
  create(userId: string, { items }: OrdersHqCreateBody) {
    console.log("ordersHqService.create", { userId, items });
    return Promise.resolve(null);
  },
};
