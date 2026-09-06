CREATE TABLE "branch_order_allocation" (
	"bod_id" integer NOT NULL,
	"hod_id" integer NOT NULL,
	"amount" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "branch_order_allocation_bod_id_hod_id_pk" PRIMARY KEY("bod_id","hod_id"),
	CONSTRAINT "branch_order_allocation_amount_positive" CHECK ("branch_order_allocation"."amount" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "branch_order_detail_bod_id_unique" ON "branch_order_detail" USING btree ("bod_id");--> statement-breakpoint
CREATE UNIQUE INDEX "head_order_detail_hod_id_unique" ON "head_order_detail" USING btree ("hod_id");--> statement-breakpoint
ALTER TABLE "branch_order_allocation" ADD CONSTRAINT "branch_order_allocation_bod_id_branch_order_detail_bod_id_fk" FOREIGN KEY ("bod_id") REFERENCES "public"."branch_order_detail"("bod_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_order_allocation" ADD CONSTRAINT "branch_order_allocation_hod_id_head_order_detail_hod_id_fk" FOREIGN KEY ("hod_id") REFERENCES "public"."head_order_detail"("hod_id") ON DELETE no action ON UPDATE no action;
