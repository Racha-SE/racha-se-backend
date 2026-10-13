-- product.cost_price was mislabeled: it's the selling price, same at every
-- branch, not a cost.
ALTER TABLE "product" RENAME COLUMN "cost_price" TO "price";

-- head_order_detail.base_price is what HQ paid the supplier for that lot —
-- a cost, not the (nonexistent, per-lot) selling price.
ALTER TABLE "head_order_detail" RENAME COLUMN "base_price" TO "cost_price";

-- branch_order_detail already had a "cost_price" column (a snapshot of the
-- old product.cost_price, i.e. the selling price) before this migration, so
-- the swap needs a temporary name to avoid colliding with it mid-rename:
--   base_price (the lot's real cost)      -> cost_price
--   cost_price (old: a price snapshot)    -> price
ALTER TABLE "branch_order_detail" RENAME COLUMN "base_price" TO "cost_price_tmp";
ALTER TABLE "branch_order_detail" RENAME COLUMN "cost_price" TO "price";
ALTER TABLE "branch_order_detail" RENAME COLUMN "cost_price_tmp" TO "cost_price";
