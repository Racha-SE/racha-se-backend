import { relations } from "drizzle-orm";
import { account, session } from "./auth";
import { branch } from "./branch";
import {
  branchOrderDetail,
  customerOrderDetail,
  headOrderDetail,
  order,
} from "./order";
import { notification } from "./notification";
import { product, productCategory, productCategoryMap } from "./product";
import { supplier } from "./supplier";
import { user } from "./user";

export const userRelations = relations(user, ({ one, many }) => ({
  branch: one(branch, {
    fields: [user.branchId],
    references: [branch.branchId],
  }),
  orders: many(order),
  sessions: many(session),
  accounts: many(account),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, {
    fields: [session.userId],
    references: [user.id],
  }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, {
    fields: [account.userId],
    references: [user.id],
  }),
}));

export const branchRelations = relations(branch, ({ many }) => ({
  users: many(user),
  branchOrderDetails: many(branchOrderDetail),
  customerOrderDetails: many(customerOrderDetail),
  notifications: many(notification),
}));

export const supplierRelations = relations(supplier, ({ many }) => ({
  headOrderDetails: many(headOrderDetail),
}));

export const productRelations = relations(product, ({ many }) => ({
  categoryMaps: many(productCategoryMap),
  headOrderDetails: many(headOrderDetail),
  branchOrderDetails: many(branchOrderDetail),
  customerOrderDetails: many(customerOrderDetail),
  notifications: many(notification),
}));

export const productCategoryRelations = relations(
  productCategory,
  ({ many }) => ({
    productMaps: many(productCategoryMap),
  }),
);

export const productCategoryMapRelations = relations(
  productCategoryMap,
  ({ one }) => ({
    product: one(product, {
      fields: [productCategoryMap.pId],
      references: [product.pId],
    }),
    category: one(productCategory, {
      fields: [productCategoryMap.categoryId],
      references: [productCategory.categoryId],
    }),
  }),
);

export const orderRelations = relations(order, ({ one, many }) => ({
  user: one(user, {
    fields: [order.userId],
    references: [user.id],
  }),
  approver: one(user, {
    fields: [order.approvedBy],
    references: [user.id],
  }),
  headOrderDetails: many(headOrderDetail),
  branchOrderDetails: many(branchOrderDetail),
  customerOrderDetails: many(customerOrderDetail),
  notifications: many(notification),
}));

export const headOrderDetailRelations = relations(
  headOrderDetail,
  ({ one }) => ({
    order: one(order, {
      fields: [headOrderDetail.lotId],
      references: [order.lotId],
    }),
    supplier: one(supplier, {
      fields: [headOrderDetail.supplierId],
      references: [supplier.supplierId],
    }),
    product: one(product, {
      fields: [headOrderDetail.pId],
      references: [product.pId],
    }),
  }),
);

export const customerOrderDetailRelations = relations(
  customerOrderDetail,
  ({ one }) => ({
    order: one(order, {
      fields: [customerOrderDetail.lotId],
      references: [order.lotId],
    }),
    branch: one(branch, {
      fields: [customerOrderDetail.branchId],
      references: [branch.branchId],
    }),
    product: one(product, {
      fields: [customerOrderDetail.pId],
      references: [product.pId],
    }),
  }),
);

export const branchOrderDetailRelations = relations(
  branchOrderDetail,
  ({ one }) => ({
    order: one(order, {
      fields: [branchOrderDetail.lotId],
      references: [order.lotId],
    }),
    branch: one(branch, {
      fields: [branchOrderDetail.branchId],
      references: [branch.branchId],
    }),
    product: one(product, {
      fields: [branchOrderDetail.pId],
      references: [product.pId],
    }),
  }),
);

export const notificationRelations = relations(notification, ({ one }) => ({
  branch: one(branch, {
    fields: [notification.branchId],
    references: [branch.branchId],
  }),
  product: one(product, {
    fields: [notification.pId],
    references: [product.pId],
  }),
  order: one(order, {
    fields: [notification.lotId],
    references: [order.lotId],
  }),
}));
