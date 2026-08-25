// Stubs only — the notification table/model exist, but nothing writes to it
// yet because the order flows that should trigger it (orders-hq.service.ts,
// orders-branch.service.ts, and the not-yet-built customer order service)
// are themselves still stubs. Once that real logic is written, wire in:
//
// - ordersHqService.create() (stock added into HQ): resolve the HQ min_stock
//   notification for each product in the order, if one is open.
// - ordersBranchService.receive() (HQ stock deducted, branch stock
//   incremented): resolve the branch's min_stock notification for each
//   product received; then, per product, if the HQ lot(s) remaining stock
//   drops below product.minStockHq after the deduction, open/keep an HQ
//   min_stock notification.
// - customer order creation (not yet scaffolded): after decrementing branch
//   stock, if it drops below product.minStockBranch, open/keep a branch
//   min_stock notification.
// - expire notifications: not created by any of the above — needs a
//   scheduled job scanning headOrderDetail/branchOrderDetail for lots
//   nearing expiredDate (not yet built).
export const notificationService = {
  listHqExpire(): Promise<null> {
    return Promise.resolve(null);
  },

  listHqMinStock(): Promise<null> {
    return Promise.resolve(null);
  },

  listBranchExpire(): Promise<null> {
    return Promise.resolve(null);
  },

  listBranchMinStock(): Promise<null> {
    return Promise.resolve(null);
  },
};
