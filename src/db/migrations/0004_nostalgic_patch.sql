CREATE TYPE "public"."notification_type" AS ENUM('low_stock', 'near_expiry');--> statement-breakpoint
CREATE TABLE "notification" (
	"notification_id" serial PRIMARY KEY NOT NULL,
	"type" "notification_type" NOT NULL,
	"p_id" integer NOT NULL,
	"branch_id" integer,
	"message" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "product" ADD COLUMN "min_stock_hq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "product" ADD COLUMN "min_stock_branch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_p_id_product_p_id_fk" FOREIGN KEY ("p_id") REFERENCES "public"."product"("p_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_branch_id_branch_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("branch_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product" DROP COLUMN "min_stock_level";
