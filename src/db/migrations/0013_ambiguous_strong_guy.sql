ALTER TABLE "branch_order_detail" DROP CONSTRAINT "branch_order_detail_available_nonnegative";--> statement-breakpoint
ALTER TABLE "head_order_detail" DROP CONSTRAINT "head_order_detail_available_nonnegative";--> statement-breakpoint
ALTER TABLE "branch_order_detail" DROP COLUMN "available";--> statement-breakpoint
ALTER TABLE "head_order_detail" DROP COLUMN "available";
