CREATE TYPE "public"."adjustment_type" AS ENUM('damaged', 'lost', 'count_error', 'other');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('pending', 'approved', 'rejected', 'completed');--> statement-breakpoint
CREATE TYPE "public"."order_type" AS ENUM('hq', 'branch', 'customer');--> statement-breakpoint
CREATE TYPE "public"."user_type" AS ENUM('hq', 'branch', 'cashier', 'customer');--> statement-breakpoint
CREATE TABLE "branch" (
	"branch_id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"address" varchar(255) NOT NULL,
	"phone_number" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "branch_order_detail" (
	"lot_id" integer NOT NULL,
	"bod_id" serial NOT NULL,
	"amount" integer NOT NULL,
	"remain" integer NOT NULL,
	"expired_date" timestamp,
	"branch_id" integer NOT NULL,
	"p_id" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "branch_order_detail_lot_id_bod_id_pk" PRIMARY KEY("lot_id","bod_id"),
	CONSTRAINT "branch_order_detail_amount_nonnegative" CHECK ("branch_order_detail"."amount" >= 0),
	CONSTRAINT "branch_order_detail_remain_nonnegative" CHECK ("branch_order_detail"."remain" >= 0)
);
--> statement-breakpoint
CREATE TABLE "customer_order_detail" (
	"lot_id" integer NOT NULL,
	"cod_id" serial NOT NULL,
	"quantity" integer NOT NULL,
	"expired_date" timestamp NOT NULL,
	"branch_id" integer NOT NULL,
	"p_id" integer NOT NULL,
	"unit_price" integer DEFAULT 0 NOT NULL,
	"unit_cost" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "customer_order_detail_lot_id_cod_id_pk" PRIMARY KEY("lot_id","cod_id"),
	CONSTRAINT "customer_order_detail_quantity_positive" CHECK ("customer_order_detail"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "head_order_detail" (
	"lot_id" integer NOT NULL,
	"hod_id" serial NOT NULL,
	"amount" integer NOT NULL,
	"remain" integer NOT NULL,
	"expired_date" timestamp NOT NULL,
	"supplier_id" integer NOT NULL,
	"p_id" integer NOT NULL,
	"unit_cost" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "head_order_detail_lot_id_hod_id_pk" PRIMARY KEY("lot_id","hod_id"),
	CONSTRAINT "head_order_detail_amount_nonnegative" CHECK ("head_order_detail"."amount" >= 0),
	CONSTRAINT "head_order_detail_remain_nonnegative" CHECK ("head_order_detail"."remain" >= 0)
);
--> statement-breakpoint
CREATE TABLE "mock_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order" (
	"lot_id" serial PRIMARY KEY NOT NULL,
	"order_type" "order_type" NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"user_id" integer NOT NULL,
	"status" "order_status" DEFAULT 'pending' NOT NULL,
	"approved_by" integer,
	"approved_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product" (
	"p_id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"barcode" varchar(255) NOT NULL,
	"base_price" integer NOT NULL,
	"cost_price" integer DEFAULT 0 NOT NULL,
	"min_stock_level" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_category" (
	"category_id" serial PRIMARY KEY NOT NULL,
	"category_name" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_category_map" (
	"p_id" integer NOT NULL,
	"category_id" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "product_category_map_p_id_category_id_pk" PRIMARY KEY("p_id","category_id")
);
--> statement-breakpoint
CREATE TABLE "stock_adjustment" (
	"adjustment_id" serial PRIMARY KEY NOT NULL,
	"branch_id" integer NOT NULL,
	"p_id" integer NOT NULL,
	"adjustment_type" "adjustment_type" NOT NULL,
	"quantity_change" integer NOT NULL,
	"reason" text NOT NULL,
	"user_id" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supplier" (
	"supplier_id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"contact" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"user_id" serial PRIMARY KEY NOT NULL,
	"user_type" "user_type" NOT NULL,
	"firstname" varchar(255) NOT NULL,
	"lastname" varchar(255) NOT NULL,
	"username" varchar(255) NOT NULL,
	"is_active" boolean NOT NULL,
	"birthdate" varchar(255),
	"password_hash" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"branch_id" integer,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_username_unique" UNIQUE("username"),
	CONSTRAINT "branch_required_for_branch_or_cashier" CHECK (("user"."user_type" NOT IN ('branch', 'cashier')) OR ("user"."branch_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "branch_order_detail" ADD CONSTRAINT "branch_order_detail_lot_id_order_lot_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."order"("lot_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_order_detail" ADD CONSTRAINT "branch_order_detail_branch_id_branch_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("branch_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_order_detail" ADD CONSTRAINT "branch_order_detail_p_id_product_p_id_fk" FOREIGN KEY ("p_id") REFERENCES "public"."product"("p_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_order_detail" ADD CONSTRAINT "customer_order_detail_lot_id_order_lot_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."order"("lot_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_order_detail" ADD CONSTRAINT "customer_order_detail_branch_id_branch_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("branch_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_order_detail" ADD CONSTRAINT "customer_order_detail_p_id_product_p_id_fk" FOREIGN KEY ("p_id") REFERENCES "public"."product"("p_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "head_order_detail" ADD CONSTRAINT "head_order_detail_lot_id_order_lot_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."order"("lot_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "head_order_detail" ADD CONSTRAINT "head_order_detail_supplier_id_supplier_supplier_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."supplier"("supplier_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "head_order_detail" ADD CONSTRAINT "head_order_detail_p_id_product_p_id_fk" FOREIGN KEY ("p_id") REFERENCES "public"."product"("p_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order" ADD CONSTRAINT "order_user_id_user_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order" ADD CONSTRAINT "order_approved_by_user_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."user"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_category_map" ADD CONSTRAINT "product_category_map_p_id_product_p_id_fk" FOREIGN KEY ("p_id") REFERENCES "public"."product"("p_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_category_map" ADD CONSTRAINT "product_category_map_category_id_product_category_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."product_category"("category_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustment" ADD CONSTRAINT "stock_adjustment_branch_id_branch_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("branch_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustment" ADD CONSTRAINT "stock_adjustment_p_id_product_p_id_fk" FOREIGN KEY ("p_id") REFERENCES "public"."product"("p_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustment" ADD CONSTRAINT "stock_adjustment_user_id_user_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_branch_id_branch_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("branch_id") ON DELETE no action ON UPDATE no action;
