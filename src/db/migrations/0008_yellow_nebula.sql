ALTER TABLE "product" ADD COLUMN "is_active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "branch_order_detail" ADD COLUMN "base_price" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "branch_order_detail" ADD COLUMN "cost_price" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "head_order_detail" ADD COLUMN "base_price" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "head_order_detail" ADD COLUMN "cost_price" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "product" DROP COLUMN "base_price";--> statement-breakpoint
ALTER TABLE "product" DROP COLUMN "cost_price";--> statement-breakpoint
ALTER TABLE "head_order_detail" DROP COLUMN "unit_cost";
