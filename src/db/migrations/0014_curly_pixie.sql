ALTER TABLE "branch" ADD CONSTRAINT "branch_name_unique" UNIQUE("name");--> statement-breakpoint
ALTER TABLE "product_category" ADD CONSTRAINT "product_category_category_name_unique" UNIQUE("category_name");
