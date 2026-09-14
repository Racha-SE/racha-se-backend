// Demo data for the HQ inventory + notification screens — local dev only.
//
// Wipes the product/supplier/order/notification tables and refills them with
// a fixed catalog whose stock deliberately trips every HQ alert: products
// under their minStockHq, lots inside the expiry warning window, an expired
// lot, an empty lot, an inactive product and a product never delivered.
// Alerts aren't inserted by hand — the script runs the real
// notificationService.scanAlerts() over the seeded stock, then checks the
// resulting alerts and inventory listing against what each product below
// says it should produce, and exits non-zero if they drift apart (e.g. after
// a change to the inventory/notification logic).
//
// Expiry dates are relative to when the script runs, so "expires in 3 days"
// stays true no matter when it's re-run. Users and branches are left alone;
// the demo HQ account is created on first run and reused after that.
import { eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import {
  headOrderDetail,
  order,
  product,
  productCategory,
  productCategoryMap,
  supplier,
  user,
} from "@/db/schema";
import { inventoryService } from "@/services/inventory.service";
import { notificationService } from "@/services/notification.service";
import { auth } from "@/utils";

if (process.env.NODE_ENV === "production") {
  console.error("Refusing to seed demo data with NODE_ENV=production.");
  process.exit(1);
}

const DEMO_HQ = {
  email: "hq.demo@racha-se.local",
  password: "DemoPassword123!",
  username: "hq_demo",
  firstname: "Demo",
  lastname: "HQ",
};

const DAY_MS = 24 * 60 * 60 * 1000;

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * DAY_MS);
}

const SUPPLIERS = {
  siamFresh: {
    name: "Siam Fresh Foods Co., Ltd.",
    contact: "sales@siamfresh.example",
  },
  bangkokDryGoods: {
    name: "Bangkok Dry Goods Trading",
    contact: "02-555-0101",
  },
  homeCare: {
    name: "HomeCare Distribution",
    contact: "orders@homecare.example",
  },
};

const CATEGORIES = [
  "Bakery",
  "Beverages",
  "Dairy & Eggs",
  "Dry Goods",
  "Frozen",
  "Household",
  "Personal Care",
  "Snacks",
] as const;

type HqAlert = "min_stock" | "expire";

interface DemoLot {
  remain: number;
  /** what HQ originally received; defaults to `remain` (nothing drawn yet) */
  amount?: number;
  /** negative = already expired */
  expiresInDays: number;
  basePrice: number;
}

interface DemoProduct {
  name: string;
  description: string;
  categories: (typeof CATEGORIES)[number][];
  supplier: keyof typeof SUPPLIERS;
  minStockHq: number;
  costPrice: number;
  isActive?: boolean;
  lots: DemoLot[];
  /** HQ alerts scanAlerts() should open for this product */
  alerts: HqAlert[];
  /** whether it shows up in GET /inventory/hq at all */
  listed: boolean;
}

// Prices are whole baht. The three blocks mirror the demo's scenarios:
// healthy stock, low stock, and expiry — then two products that must not
// appear in the inventory listing at all.
const PRODUCTS: DemoProduct[] = [
  // --- Healthy stock: no alerts ---
  {
    name: "Drinking Water 600ml",
    description: "Bottled drinking water, 600ml.",
    categories: ["Beverages"],
    supplier: "siamFresh",
    minStockHq: 100,
    costPrice: 5,
    lots: [
      { remain: 240, amount: 300, expiresInDays: 365, basePrice: 5 },
      { remain: 120, expiresInDays: 300, basePrice: 5 },
    ],
    alerts: [],
    listed: true,
  },
  {
    // Three lots at different prices/expiries — shows lot-level detail.
    name: "Jasmine Rice 5kg",
    description: "Thai Hom Mali jasmine rice, 5kg bag.",
    categories: ["Dry Goods"],
    supplier: "bangkokDryGoods",
    minStockHq: 50,
    costPrice: 165,
    lots: [
      { remain: 80, expiresInDays: 300, basePrice: 170 },
      { remain: 60, amount: 100, expiresInDays: 200, basePrice: 165 },
      { remain: 40, amount: 120, expiresInDays: 120, basePrice: 160 },
    ],
    alerts: [],
    listed: true,
  },
  {
    name: "Potato Chips Original 75g",
    description: "Salted potato chips, 75g bag.",
    categories: ["Snacks"],
    supplier: "bangkokDryGoods",
    minStockHq: 60,
    costPrice: 20,
    lots: [{ remain: 150, expiresInDays: 90, basePrice: 20 }],
    alerts: [],
    listed: true,
  },
  {
    name: "Green Tea 500ml",
    description: "Unsweetened bottled green tea, 500ml.",
    categories: ["Beverages"],
    supplier: "siamFresh",
    minStockHq: 50,
    costPrice: 15,
    lots: [{ remain: 180, amount: 240, expiresInDays: 150, basePrice: 15 }],
    alerts: [],
    listed: true,
  },
  {
    name: "Instant Coffee 3-in-1 (27 sachets)",
    description: "Coffee, creamer and sugar mix, 27 sachets per pack.",
    categories: ["Beverages"],
    supplier: "bangkokDryGoods",
    minStockHq: 30,
    costPrice: 95,
    lots: [{ remain: 75, expiresInDays: 240, basePrice: 95 }],
    alerts: [],
    listed: true,
  },
  {
    // Expires in 10 days — just outside the 7-day warning window, so no
    // expire alert yet.
    name: "Orange Juice 1L",
    description: "100% orange juice, chilled, 1 litre.",
    categories: ["Beverages"],
    supplier: "siamFresh",
    minStockHq: 30,
    costPrice: 55,
    lots: [{ remain: 50, expiresInDays: 10, basePrice: 55 }],
    alerts: [],
    listed: true,
  },
  {
    name: "Fish Sauce 700ml",
    description: "Premium fish sauce, 700ml glass bottle.",
    categories: ["Dry Goods"],
    supplier: "bangkokDryGoods",
    minStockHq: 25,
    costPrice: 30,
    lots: [{ remain: 60, expiresInDays: 500, basePrice: 30 }],
    alerts: [],
    listed: true,
  },
  {
    name: "Frozen Pork Dumplings 500g",
    description: "Steamed pork dumplings, frozen, 500g pack.",
    categories: ["Frozen"],
    supplier: "siamFresh",
    minStockHq: 40,
    costPrice: 95,
    lots: [{ remain: 100, expiresInDays: 45, basePrice: 95 }],
    alerts: [],
    listed: true,
  },
  {
    name: "Shampoo 400ml",
    description: "Everyday shampoo for all hair types, 400ml.",
    categories: ["Personal Care"],
    supplier: "homeCare",
    minStockHq: 20,
    costPrice: 89,
    lots: [{ remain: 90, expiresInDays: 700, basePrice: 89 }],
    alerts: [],
    listed: true,
  },
  {
    name: "Dishwashing Liquid 500ml",
    description: "Lemon-scented dishwashing liquid, 500ml.",
    categories: ["Household"],
    supplier: "homeCare",
    minStockHq: 20,
    costPrice: 35,
    lots: [{ remain: 70, expiresInDays: 730, basePrice: 35 }],
    alerts: [],
    listed: true,
  },
  {
    name: "Tissue Paper (6 rolls)",
    description: "2-ply toilet tissue, pack of 6 rolls.",
    categories: ["Household"],
    supplier: "homeCare",
    minStockHq: 30,
    costPrice: 79,
    lots: [{ remain: 110, expiresInDays: 900, basePrice: 79 }],
    alerts: [],
    listed: true,
  },

  // --- Low stock: total remaining under minStockHq ---
  {
    name: "Instant Noodles Tom Yum 60g",
    description: "Tom yum shrimp flavour instant noodles, 60g.",
    categories: ["Dry Goods"],
    supplier: "bangkokDryGoods",
    minStockHq: 200,
    costPrice: 6,
    lots: [{ remain: 45, amount: 400, expiresInDays: 150, basePrice: 6 }],
    alerts: ["min_stock"],
    listed: true,
  },
  {
    name: "Canned Tuna in Water 185g",
    description: "Tuna chunks in spring water, 185g can.",
    categories: ["Dry Goods"],
    supplier: "bangkokDryGoods",
    minStockHq: 100,
    costPrice: 35,
    lots: [{ remain: 20, amount: 150, expiresInDays: 400, basePrice: 35 }],
    alerts: ["min_stock"],
    listed: true,
  },
  {
    // 70 against a minimum of 80 — only just under.
    name: "Milk Chocolate Bar 40g",
    description: "Milk chocolate bar, 40g.",
    categories: ["Snacks"],
    supplier: "bangkokDryGoods",
    minStockHq: 80,
    costPrice: 25,
    lots: [{ remain: 70, amount: 200, expiresInDays: 60, basePrice: 25 }],
    alerts: ["min_stock"],
    listed: true,
  },
  {
    // Its only lot has been fully drawn down: out of stock, so it drops out
    // of the inventory listing (remain > 0 only) but still raises min_stock.
    name: "Eggs (pack of 10)",
    description: "Fresh chicken eggs, size M, pack of 10.",
    categories: ["Dairy & Eggs"],
    supplier: "siamFresh",
    minStockHq: 40,
    costPrice: 55,
    lots: [{ remain: 0, amount: 100, expiresInDays: 10, basePrice: 55 }],
    alerts: ["min_stock"],
    listed: false,
  },

  // --- Expiry ---
  {
    // Plenty in total, but one of its two lots expires in 3 days.
    name: "Fresh Milk 1L",
    description: "Pasteurised whole milk, 1 litre.",
    categories: ["Dairy & Eggs"],
    supplier: "siamFresh",
    minStockHq: 40,
    costPrice: 45,
    lots: [
      { remain: 60, amount: 100, expiresInDays: 3, basePrice: 45 },
      { remain: 80, expiresInDays: 20, basePrice: 46 },
    ],
    alerts: ["expire"],
    listed: true,
  },
  {
    // Already expired 2 days ago. It's still on the shelf, so it's listed —
    // but expired stock isn't drawable, so HQ's usable stock is 0 (a
    // min_stock alert), and the expire alert window only covers lots that
    // haven't expired yet.
    name: "Whole Wheat Bread",
    description: "Sliced whole wheat sandwich bread, 500g loaf.",
    categories: ["Bakery"],
    supplier: "siamFresh",
    minStockHq: 30,
    costPrice: 40,
    lots: [{ remain: 35, amount: 60, expiresInDays: -2, basePrice: 40 }],
    alerts: ["min_stock"],
    listed: true,
  },
  {
    // Both at once: low stock and expiring in 5 days.
    name: "Greek Yogurt 150g",
    description: "Plain strained Greek yogurt, 150g cup.",
    categories: ["Dairy & Eggs", "Snacks"],
    supplier: "siamFresh",
    minStockHq: 50,
    costPrice: 22,
    lots: [{ remain: 12, amount: 80, expiresInDays: 5, basePrice: 22 }],
    alerts: ["min_stock", "expire"],
    listed: true,
  },

  // --- Must not appear in the inventory listing ---
  {
    // Deactivated: excluded from the listing and from alert scans, even
    // though it still has stock.
    name: "Classic Cola 325ml (discontinued)",
    description: "Discontinued line — kept for order history only.",
    categories: ["Beverages"],
    supplier: "siamFresh",
    minStockHq: 20,
    costPrice: 12,
    isActive: false,
    lots: [{ remain: 50, expiresInDays: 30, basePrice: 12 }],
    alerts: [],
    listed: false,
  },
  {
    // In the catalog but never delivered — zero stock, no lots.
    name: "Cooking Oil 1L",
    description: "Refined soybean cooking oil, 1 litre.",
    categories: ["Dry Goods"],
    supplier: "bangkokDryGoods",
    minStockHq: 30,
    costPrice: 52,
    lots: [],
    alerts: ["min_stock"],
    listed: false,
  },
];

/** Creates the demo HQ account on first run, reuses it after that. */
async function ensureDemoHqUser() {
  const [existing] = await db
    .select({ id: user.id, userType: user.userType, branchId: user.branchId })
    .from(user)
    .where(eq(user.email, DEMO_HQ.email));
  if (existing) return existing;

  const created = await auth.api.createUser({
    body: {
      email: DEMO_HQ.email,
      password: DEMO_HQ.password,
      name: `${DEMO_HQ.firstname} ${DEMO_HQ.lastname}`,
      data: {
        userType: "hq",
        firstname: DEMO_HQ.firstname,
        lastname: DEMO_HQ.lastname,
        username: DEMO_HQ.username,
      },
    },
  });
  return { id: created.user.id, userType: "hq" as const, branchId: null };
}

async function seed(hqUserId: string) {
  await db.transaction(async (tx) => {
    // Every table referencing these is listed explicitly instead of relying
    // on CASCADE, so a new table that points at them makes this fail loudly
    // rather than getting silently emptied.
    await tx.execute(sql`
      TRUNCATE TABLE
        notification,
        customer_order_detail,
        branch_order_detail,
        head_order_detail,
        "order",
        product_category_map,
        product,
        product_category,
        supplier
      RESTART IDENTITY
    `);

    const supplierIds = new Map<keyof typeof SUPPLIERS, number>();
    for (const [key, values] of Object.entries(SUPPLIERS)) {
      const [created] = await tx
        .insert(supplier)
        .values(values)
        .returning({ supplierId: supplier.supplierId });
      supplierIds.set(key as keyof typeof SUPPLIERS, created.supplierId);
    }

    const categoryIds = new Map(
      (
        await tx
          .insert(productCategory)
          .values(CATEGORIES.map((categoryName) => ({ categoryName })))
          .returning()
      ).map((row) => [row.categoryName, row.categoryId]),
    );

    // One HQ order (delivery) per supplier, the way ordersHqService.create
    // records one: approved on creation, by the HQ user who placed it.
    const lotIds = new Map<keyof typeof SUPPLIERS, number>();
    for (const key of supplierIds.keys()) {
      const [created] = await tx
        .insert(order)
        .values({
          orderType: "hq",
          userId: hqUserId,
          status: "approved",
          approvedBy: hqUserId,
          approvedAt: new Date(),
        })
        .returning({ lotId: order.lotId });
      lotIds.set(key, created.lotId);
    }

    for (const [index, demo] of PRODUCTS.entries()) {
      const [created] = await tx
        .insert(product)
        .values({
          name: demo.name,
          description: demo.description,
          // GS1 prefix 20-29 is reserved for in-store use, so these can never
          // collide with a real product's barcode.
          barcode: `2000000000${String(index + 1).padStart(3, "0")}`,
          minStockHq: demo.minStockHq,
          costPrice: demo.costPrice,
          isActive: demo.isActive ?? true,
        })
        .returning({ pId: product.pId });

      await tx.insert(productCategoryMap).values(
        demo.categories.map((name) => ({
          pId: created.pId,
          categoryId: categoryIds.get(name)!,
        })),
      );

      if (demo.lots.length > 0) {
        await tx.insert(headOrderDetail).values(
          demo.lots.map((lot) => ({
            lotId: lotIds.get(demo.supplier)!,
            amount: lot.amount ?? lot.remain,
            remain: lot.remain,
            expiredDate: daysFromNow(lot.expiresInDays),
            supplierId: supplierIds.get(demo.supplier)!,
            pId: created.pId,
            basePrice: lot.basePrice,
          })),
        );
      }
    }
  });
}

/** Names that are in one list but not the other, for the failure message. */
function diff(expected: string[], actual: string[]) {
  return {
    missing: expected.filter((name) => !actual.includes(name)),
    unexpected: actual.filter((name) => !expected.includes(name)),
  };
}

const hqUser = await ensureDemoHqUser();
await seed(hqUser.id);
const scan = await notificationService.scanAlerts();

const [minStockAlerts, expireAlerts, inventory] = await Promise.all([
  notificationService.listHqMinStock(),
  notificationService.listHqExpire(),
  inventoryService.getHqStock(hqUser, { groupBy: true, limit: 100 }),
]);

const checks = {
  "HQ min_stock alerts": diff(
    PRODUCTS.filter((p) => p.alerts.includes("min_stock")).map((p) => p.name),
    minStockAlerts.map((alert) => alert.productName),
  ),
  "HQ expire alerts": diff(
    PRODUCTS.filter((p) => p.alerts.includes("expire")).map((p) => p.name),
    expireAlerts.map((alert) => alert.productName),
  ),
  "GET /inventory/hq products": diff(
    PRODUCTS.filter((p) => p.listed).map((p) => p.name),
    inventory.inventory.map((item) => item.productName),
  ),
};

const failures = Object.entries(checks).filter(
  ([, { missing, unexpected }]) => missing.length > 0 || unexpected.length > 0,
);

if (failures.length > 0) {
  console.error("Demo data seeded, but it doesn't produce what it should:");
  for (const [label, { missing, unexpected }] of failures) {
    console.error(`  ${label}`);
    if (missing.length > 0)
      console.error(`    missing:    ${missing.join(", ")}`);
    if (unexpected.length > 0)
      console.error(`    unexpected: ${unexpected.join(", ")}`);
  }
  process.exit(1);
}

const lotCount = PRODUCTS.flatMap((p) => p.lots).length;
console.log(
  `Seeded ${PRODUCTS.length} products, ${lotCount} HQ lots, ` +
    `${Object.keys(SUPPLIERS).length} suppliers, ${CATEGORIES.length} categories.`,
);
console.log(
  `Alerts opened by scanAlerts(): ${scan.hqExpireOpened} expire, ` +
    `${minStockAlerts.length} min_stock.`,
);
console.log(
  `  min_stock: ${minStockAlerts.map((a) => a.productName).join(", ")}`,
);
console.log(
  `  expire:    ${expireAlerts.map((a) => a.productName).join(", ")}`,
);
console.log(`\nSign in as HQ: ${DEMO_HQ.email} / ${DEMO_HQ.password}`);
process.exit(0);
