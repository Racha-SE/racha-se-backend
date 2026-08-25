export const ordersHqService = {
  // TODO: once this writes head_order_detail rows for real, resolve the HQ
  // min_stock notification for each product in the order — see
  // notification.service.ts's top comment.
  create(): Promise<null> {
    return Promise.resolve(null);
  },
};
