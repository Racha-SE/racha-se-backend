CREATE TABLE "stock_adjustment" (
	"adjustment_id" serial PRIMARY KEY NOT NULL,
	"branch_id" integer NOT NULL,
	"p_id" integer NOT NULL,
	"quantity_change" integer NOT NULL,
	"reason" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "stock_adjustment_quantity_change_nonzero" CHECK ("stock_adjustment"."quantity_change" <> 0)
);
--> statement-breakpoint
ALTER TABLE "stock_adjustment" ADD CONSTRAINT "stock_adjustment_branch_id_branch_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("branch_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustment" ADD CONSTRAINT "stock_adjustment_p_id_product_p_id_fk" FOREIGN KEY ("p_id") REFERENCES "public"."product"("p_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustment" ADD CONSTRAINT "stock_adjustment_user_id_user_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("user_id") ON DELETE no action ON UPDATE no action;
