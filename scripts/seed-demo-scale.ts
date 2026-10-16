// Large-scale demo data — local dev only, separate from scripts/seed-demo.ts.
//
// seed-demo.ts hand-curates ~20 products so every HQ alert has exactly one
// thing to show, and self-checks against that fixed list. This script does
// the opposite: it generates a whole retail network (suppliers, products,
// branches, HQ/branch/cashier accounts) at a scale meant for load-testing
// the UI and demoing the full order lifecycle, not for asserting exact
// alert output. Numbers are randomised on every run.
//
// It drives the real services end to end for every order (orders-hq,
// orders-branch, orders-customer) instead of hand-inserting rows, so the
// resulting stock levels, FEFO draws and notifications are exactly what the
// real app would have produced.
//
// Branches and users are idempotent (looked up by name/email, created once,
// reused on every re-run — same reasoning as seed-demo.ts's demo HQ
// account). The catalog (suppliers/products/orders/notifications) is wiped
// and regenerated fresh every run.
import { and, eq, gt, sql } from "drizzle-orm";
import { db } from "@/db/client";
import {
  branch,
  branchOrderDetail,
  headOrderDetail,
  order,
  product,
  productCategory,
  productCategoryMap,
  supplier,
  user,
} from "@/db/schema";
import { ordersHqService } from "@/services/orders-hq.service";
import { ordersBranchService } from "@/services/orders-branch.service";
import { ordersCustomerService } from "@/services/orders-customer.service";
import { notificationService } from "@/services/notification.service";
import type { UserType } from "@/utils/hierarchy";
import { auth } from "@/utils";

if (process.env.NODE_ENV === "production") {
  console.error("Refusing to seed demo data with NODE_ENV=production.");
  process.exit(1);
}

// --- Scale knobs -----------------------------------------------------------
const SUPPLIER_COUNT = 50;
const PRODUCT_COUNT = 200;
const BRANCH_COUNT = 20;
const HQ_ACCOUNT_COUNT = 5;
const MANAGERS_PER_BRANCH = 2;
const CASHIERS_PER_BRANCH = 3;
// Each branch places this many separate orders ("lots") to HQ, each
// requesting a distinct slice of the catalog — guarantees every branch ends
// up with BATCHES_PER_BRANCH * PRODUCTS_PER_BATCH distinct products ordered
// (120 >= the 100 minimum) across at least BATCHES_PER_BRANCH lots
// (12 >= the 10 minimum).
const BATCHES_PER_BRANCH = 12;
const PRODUCTS_PER_BATCH = 10;
const CUSTOMER_SALES_PER_BRANCH = 15;
// Fraction of a branch's (resp. HQ's) stocked products that get a
// deliberately soon-expiring lot, so notificationService.scanAlerts() has
// real expire alerts to find at both scopes, not just min_stock.
const BRANCH_EXPIRE_RATIO = 0.05;
const HQ_EXPIRE_RATIO = 0.05;
const EXPIRE_SOON_MIN_DAYS = 1;
const EXPIRE_SOON_MAX_DAYS = 6; // inside notification.service.ts's 7-day window
// Fraction of products (resp. a branch's products) deliberately kept below
// product.minStockHq / minStockBranch, so min_stock alerts have real,
// permanent cases to show too — not just expire.
const HQ_MIN_STOCK_RATIO = 0.1;
const BRANCH_MIN_STOCK_RATIO = 0.1;
// Fraction of products given one small lot that already expired before this
// script ran — "old stock still sitting on the shelf" (see seed-demo.ts's
// Whole Wheat Bread), stacked on top of that product's normal stock.
const HQ_ALREADY_EXPIRED_RATIO = 0.05;
const EXPIRED_PAST_MIN_DAYS = 1;
const EXPIRED_PAST_MAX_DAYS = 30;
const SCALE_PASSWORD = "DemoScale123!";

const DAY_MS = 24 * 60 * 60 * 1000;
function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * DAY_MS);
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pickOne<T>(items: readonly T[]): T {
  return items[randInt(0, items.length - 1)];
}

/** Fisher-Yates shuffle of a copy — never mutates the input. */
function shuffled<T>(items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = randInt(0, i);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

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

const CATEGORY_NOUNS: Record<(typeof CATEGORIES)[number], string[]> = {
  Bakery: [
    "White Bread",
    "Croissant",
    "Dinner Roll",
    "Baguette",
    "Muffin",
    "Donut",
    "Cracker",
    "Cake Slice",
  ],
  Beverages: [
    "Drinking Water",
    "Green Tea",
    "Orange Juice",
    "Cola",
    "Energy Drink",
    "Soy Milk",
    "Coffee Drink",
    "Soda Water",
  ],
  "Dairy & Eggs": [
    "Fresh Milk",
    "Yogurt",
    "Cheese Slice",
    "Butter",
    "Eggs",
    "Whipping Cream",
    "Chocolate Milk",
    "Condensed Milk",
  ],
  "Dry Goods": [
    "Jasmine Rice",
    "Fish Sauce",
    "Soy Sauce",
    "Instant Noodles",
    "Canned Tuna",
    "Cooking Oil",
    "Sugar",
    "Flour",
  ],
  Frozen: [
    "Pork Dumplings",
    "Frozen Vegetables",
    "Ice Cream",
    "Frozen Shrimp",
    "Chicken Nuggets",
    "Frozen Pizza",
    "Fish Fillet",
    "Frozen Corn",
  ],
  Household: [
    "Dishwashing Liquid",
    "Tissue Paper",
    "Laundry Detergent",
    "Trash Bag",
    "Air Freshener",
    "Fabric Softener",
    "Sponge",
    "Floor Cleaner",
  ],
  "Personal Care": [
    "Shampoo",
    "Soap Bar",
    "Toothpaste",
    "Body Lotion",
    "Hand Sanitizer",
    "Deodorant",
    "Facial Wash",
    "Sunscreen",
  ],
  Snacks: [
    "Potato Chips",
    "Chocolate Bar",
    "Biscuit",
    "Popcorn",
    "Peanuts",
    "Crackers",
    "Candy",
    "Dried Fruit",
  ],
};

const VARIANTS = [
  "50g",
  "100g",
  "250g",
  "500g",
  "1L",
  "1kg",
  "5kg",
  "Pack of 6",
  "Family Size",
  "Mini Pack",
  "700ml",
  "2L",
];

interface GeneratedProduct {
  name: string;
  category: (typeof CATEGORIES)[number];
}

/** All (noun, variant) combinations, tagged with the noun's category. */
function allProductCombos(): GeneratedProduct[] {
  const combos: GeneratedProduct[] = [];
  for (const category of CATEGORIES) {
    for (const noun of CATEGORY_NOUNS[category]) {
      for (const variant of VARIANTS) {
        combos.push({ name: `${noun} ${variant}`, category });
      }
    }
  }
  return combos;
}

type Actor = { id: string; userType: UserType; branchId: number | null };

/** Looks a branch up by name, creates it if missing — kept across runs. */
async function ensureBranch(name: string, index: number) {
  const [existing] = await db
    .select({ branchId: branch.branchId })
    .from(branch)
    .where(eq(branch.name, name));
  if (existing) return existing.branchId;

  const [created] = await db
    .insert(branch)
    .values({
      name,
      address: `${index} Demo Industrial Estate, Bangkok`,
      phoneNumber: `02-500-${String(1000 + index).slice(-4)}`,
    })
    .returning({ branchId: branch.branchId });
  return created.branchId;
}

/**
 * Looks a user up by email, creates it if missing — kept across runs. If
 * `role` is given and an already-existing row (from a run before this
 * script granted it) doesn't have it yet, reconciles it in place — so
 * re-running after this change still fixes accounts seeded by an older
 * version of this script, not just fresh ones.
 */
async function ensureUser(opts: {
  email: string;
  username: string;
  firstname: string;
  lastname: string;
  userType: UserType;
  branchId: number | null;
  /** better-auth admin-plugin role — separate from `userType`. Only
   * "admin" unlocks the frontend's root-only pages (e.g. user management). */
  role?: "admin";
}): Promise<Actor> {
  const [existing] = await db
    .select({
      id: user.id,
      userType: user.userType,
      branchId: user.branchId,
      role: user.role,
    })
    .from(user)
    .where(eq(user.email, opts.email));
  if (existing) {
    if (opts.role && existing.role !== opts.role) {
      await db
        .update(user)
        .set({ role: opts.role })
        .where(eq(user.id, existing.id));
    }
    return existing;
  }

  const created = await auth.api.createUser({
    body: {
      email: opts.email,
      password: SCALE_PASSWORD,
      name: `${opts.firstname} ${opts.lastname}`,
      role: opts.role,
      data: {
        userType: opts.userType,
        firstname: opts.firstname,
        lastname: opts.lastname,
        username: opts.username,
        branchId: opts.branchId,
      },
    },
  });
  return {
    id: created.user.id,
    userType: opts.userType,
    branchId: opts.branchId,
  };
}

async function wipeCatalog() {
  // Same table list as seed-demo.ts, for the same reason: every table that
  // references product/supplier has to be truncated together, or Postgres
  // refuses (dangling FKs). Branch and user are deliberately absent —
  // they're idempotent, not regenerated.
  await db.execute(sql`
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
}

async function main() {
  const startedAt = Date.now();

  console.log("Setting up branches...");
  const branchIds: number[] = [];
  for (let i = 1; i <= BRANCH_COUNT; i++) {
    branchIds.push(
      await ensureBranch(`Branch ${String(i).padStart(2, "0")}`, i),
    );
  }

  console.log(`Setting up ${HQ_ACCOUNT_COUNT} HQ accounts...`);
  const hqUsers: Actor[] = [];
  for (let i = 1; i <= HQ_ACCOUNT_COUNT; i++) {
    hqUsers.push(
      await ensureUser({
        email: `hq${String(i).padStart(2, "0")}.scale@racha-se.local`,
        username: `hq_scale_${String(i).padStart(2, "0")}`,
        firstname: "HQ",
        lastname: `Scale${i}`,
        userType: "hq",
        branchId: null,
        // Grants the frontend's root-only pages (e.g. user management,
        // gated on session.user.role === "admin", not userType) — separate
        // from the MANAGER_USER_TYPES check the backend API itself uses.
        role: "admin",
      }),
    );
  }

  console.log(
    `Setting up ${MANAGERS_PER_BRANCH} manager + ${CASHIERS_PER_BRANCH} cashier accounts per branch...`,
  );
  const branchManagers = new Map<number, Actor[]>();
  const branchCashiers = new Map<number, Actor[]>();
  for (let b = 0; b < BRANCH_COUNT; b++) {
    const branchId = branchIds[b];
    const branchLabel = String(b + 1).padStart(2, "0");

    const managers: Actor[] = [];
    for (let m = 1; m <= MANAGERS_PER_BRANCH; m++) {
      managers.push(
        await ensureUser({
          email: `branch${branchLabel}.manager${m}.scale@racha-se.local`,
          username: `branch${branchLabel}_mgr${m}`,
          firstname: `Branch${branchLabel}`,
          lastname: `Manager${m}`,
          userType: "branch",
          branchId,
          // Backend-side, a "branch" account already manages its own
          // branch's cashiers (MANAGER_USER_TYPES in users.route.ts) — this
          // just unlocks the frontend's root-only /user-management page for
          // them too, same reasoning as the HQ accounts above. Cashiers
          // don't get it: they can't manage anyone on the backend either.
          role: "admin",
        }),
      );
    }
    branchManagers.set(branchId, managers);

    const cashiers: Actor[] = [];
    for (let c = 1; c <= CASHIERS_PER_BRANCH; c++) {
      cashiers.push(
        await ensureUser({
          email: `branch${branchLabel}.cashier${c}.scale@racha-se.local`,
          username: `branch${branchLabel}_cashier${c}`,
          firstname: `Branch${branchLabel}`,
          lastname: `Cashier${c}`,
          userType: "cashier",
          branchId,
        }),
      );
    }
    branchCashiers.set(branchId, cashiers);
  }

  console.log("Wiping product/supplier/order/notification tables...");
  await wipeCatalog();

  console.log(`Creating ${CATEGORIES.length} categories...`);
  const categoryRows = await db
    .insert(productCategory)
    .values(CATEGORIES.map((categoryName) => ({ categoryName })))
    .returning();
  const categoryIds = new Map(
    categoryRows.map((row) => [row.categoryName, row.categoryId]),
  );

  console.log(`Creating ${SUPPLIER_COUNT} suppliers...`);
  const supplierRows = await db
    .insert(supplier)
    .values(
      Array.from({ length: SUPPLIER_COUNT }, (_, i) => ({
        name: `Supplier ${String(i + 1).padStart(2, "0")} Co., Ltd.`,
        contact: `supplier${String(i + 1).padStart(2, "0")}@example.com`,
      })),
    )
    .returning({ supplierId: supplier.supplierId });
  const supplierIds = supplierRows.map((row) => row.supplierId);

  console.log(`Creating ${PRODUCT_COUNT} products...`);
  const combos = shuffled(allProductCombos()).slice(0, PRODUCT_COUNT);

  interface BuiltProduct {
    pId: number;
    price: number;
    supplierId: number;
    minStockHq: number;
    minStockBranch: number;
  }
  const products: BuiltProduct[] = [];

  for (const [index, combo] of combos.entries()) {
    const price = randInt(10, 300);
    const supplierId = supplierIds[index % supplierIds.length];
    const minStockHq = randInt(30, 120);
    const minStockBranch = randInt(5, 30);

    const [created] = await db
      .insert(product)
      .values({
        name: combo.name,
        description: `${combo.name} — demo scale catalog item.`,
        // GS1 prefix 20-29 is reserved for in-store use, never collides with
        // a real product's barcode.
        barcode: `2100000000${String(index + 1).padStart(3, "0")}`,
        minStockHq,
        minStockBranch,
        price,
      })
      .returning({ pId: product.pId });

    const categoryId = categoryIds.get(combo.category);
    if (categoryId) {
      await db
        .insert(productCategoryMap)
        .values({ pId: created.pId, categoryId });
    }

    products.push({
      pId: created.pId,
      price,
      supplierId,
      minStockHq,
      minStockBranch,
    });
  }

  const productById = new Map(products.map((p) => [p.pId, p]));

  // ~10% of products are deliberately kept below product.minStockHq,
  // forever: excluded from the normal restocking below (lot count forced to
  // 0 there) and from every branch's ordering pool (further down), so
  // nothing ever tops them up or draws them away from being a real min_stock
  // alert at HQ.
  const hqMinStockFlagged = new Set(
    shuffled(products)
      .slice(0, Math.max(1, Math.round(PRODUCT_COUNT * HQ_MIN_STOCK_RATIO)))
      .map((p) => p.pId),
  );
  // A separate, disjoint ~5% get one small lot that already expired before
  // this script ran, stacked on top of their normal (healthy) stock — "old
  // stock still sitting on the shelf", not a min_stock/expire alert source.
  const hqAlreadyExpiredFlagged = shuffled(
    products.filter((p) => !hqMinStockFlagged.has(p.pId)),
  ).slice(0, Math.max(1, Math.round(PRODUCT_COUNT * HQ_ALREADY_EXPIRED_RATIO)));

  const productsBySupplier = new Map<number, BuiltProduct[]>();
  for (const p of products) {
    const list = productsBySupplier.get(p.supplierId) ?? [];
    list.push(p);
    productsBySupplier.set(p.supplierId, list);
  }

  const hqOrderUser = () => pickOne(hqUsers);

  // Each product gets its own number of restock lots — not locked to a
  // fixed round count — with ~50% odds of landing on more than one, so
  // inventory actually shows several simultaneous, non-empty lots for the
  // same product at HQ, not just one. The min_stock-flagged products get 0
  // here on purpose — their only lot is the deliberately-small one below.
  const hqLotCounts = new Map<number, number>();
  for (const p of products) {
    hqLotCounts.set(
      p.pId,
      hqMinStockFlagged.has(p.pId)
        ? 0
        : Math.random() < 0.5
          ? 1
          : randInt(2, 5),
    );
  }
  const maxHqLotRounds = Math.max(...hqLotCounts.values());

  console.log(
    `Stocking HQ with 1-5 restock lots per product (${maxHqLotRounds} rounds)...`,
  );
  for (let lotRound = 0; lotRound < maxHqLotRounds; lotRound++) {
    for (const supplierId of supplierIds) {
      const supplierProducts = (
        productsBySupplier.get(supplierId) ?? []
      ).filter((p) => (hqLotCounts.get(p.pId) ?? 1) > lotRound);
      if (supplierProducts.length === 0) continue;

      const items = supplierProducts.map((p) => {
        // First round: a generous, long-dated restock. Later rounds: smaller
        // top-ups, sooner-expiring but still outside the 7-day expire window
        // — real near-expiry lots are added separately below (a tiny
        // fraction of products/branches), so scanAlerts() finds some without
        // every product tripping an alert.
        const amount =
          lotRound === 0 ? randInt(3000, 6000) : randInt(800, 3000);
        const expiresInDays =
          lotRound === 0 ? randInt(120, 400) : randInt(30, 90);
        const costPrice = Math.max(
          1,
          Math.round((p.price * randInt(50, 75)) / 100),
        );
        return {
          pId: p.pId,
          supplierId,
          amount,
          expiredDate: daysFromNow(expiresInDays).toISOString(),
          costPrice,
        };
      });

      await ordersHqService.create(hqOrderUser().id, { items });
    }
  }

  console.log(
    `Keeping ${hqMinStockFlagged.size} products under their HQ min stock...`,
  );
  await ordersHqService.create(hqOrderUser().id, {
    items: [...hqMinStockFlagged].map((pId) => {
      const p = productById.get(pId)!;
      return {
        pId,
        supplierId: p.supplierId,
        amount: randInt(1, Math.max(1, p.minStockHq - 1)),
        expiredDate: daysFromNow(randInt(120, 400)).toISOString(),
        costPrice: Math.max(1, Math.round((p.price * randInt(50, 75)) / 100)),
      };
    }),
  });

  console.log(
    `Leaving ${hqAlreadyExpiredFlagged.length} products with a small, already-expired lot...`,
  );
  await ordersHqService.create(hqOrderUser().id, {
    items: hqAlreadyExpiredFlagged.map((p) => ({
      pId: p.pId,
      supplierId: p.supplierId,
      amount: randInt(10, 50),
      // In the past — ordersHqService.create itself doesn't validate this
      // (only the route's model schema does, which this script bypasses by
      // calling the service directly), so this lands as real old stock: on
      // the shelf (remain > 0) but never counted as usable, and never
      // flagged by checkExpiringLots either (that only looks forward).
      expiredDate: daysFromNow(
        -randInt(EXPIRED_PAST_MIN_DAYS, EXPIRED_PAST_MAX_DAYS),
      ).toISOString(),
      costPrice: Math.max(1, Math.round((p.price * randInt(50, 75)) / 100)),
    })),
  });

  console.log(
    `Placing ${BATCHES_PER_BRANCH} branch orders per branch (${BATCHES_PER_BRANCH * PRODUCTS_PER_BATCH} distinct products each)...`,
  );
  let totalBranchOrders = 0;
  let totalBranchLines = 0;
  const branchDistinctProducts = new Map<number, Set<number>>();
  const branchOrderCounts = new Map<number, number>();
  const branchExpireFlaggedCounts = new Map<number, number>();
  const branchMinStockFlaggedCounts = new Map<number, number>();

  // Branches never request the HQ-min-stock-flagged products at all — if
  // they did, 20 branches competing over a handful of deliberately-tiny
  // lots would throw INSUFFICIENT_STOCK often enough to risk dragging a
  // branch's distinct-product count under the 100 minimum.
  const branchOrderablePool = products.filter(
    (p) => !hqMinStockFlagged.has(p.pId),
  );

  for (const [branchIndex, branchId] of branchIds.entries()) {
    const managers = branchManagers.get(branchId)!;
    const pool = shuffled(branchOrderablePool).slice(
      0,
      BATCHES_PER_BRANCH * PRODUCTS_PER_BATCH,
    );
    const distinctForBranch = new Set<number>();
    // ~10% of this branch's own pool are deliberately ordered below
    // product.minStockBranch, and excluded below from the "overlap" and
    // near-expiry top-ups so nothing tops them back up.
    const branchMinStockFlagged = new Set(
      shuffled(pool)
        .slice(0, Math.max(1, Math.round(pool.length * BRANCH_MIN_STOCK_RATIO)))
        .map((p) => p.pId),
    );
    branchMinStockFlaggedCounts.set(branchId, branchMinStockFlagged.size);

    for (let batch = 0; batch < BATCHES_PER_BRANCH; batch++) {
      const batchProducts = pool.slice(
        batch * PRODUCTS_PER_BATCH,
        (batch + 1) * PRODUCTS_PER_BATCH,
      );

      const requester = pickOne(managers);
      const items = batchProducts.map((p) => ({
        pId: p.pId,
        amount: branchMinStockFlagged.has(p.pId)
          ? randInt(1, Math.max(1, p.minStockBranch - 1))
          : randInt(10, 40),
      }));

      try {
        const created = await ordersBranchService.create(
          requester.id,
          branchId,
          { items },
        );
        await ordersBranchService.approve(created.lotId, hqOrderUser().id);
        await ordersBranchService.receive(created.lotId, branchId);

        totalBranchOrders += 1;
        totalBranchLines += items.length;
        branchOrderCounts.set(
          branchId,
          (branchOrderCounts.get(branchId) ?? 0) + 1,
        );
        for (const item of items) distinctForBranch.add(item.pId);
      } catch (error) {
        // HQ stock is sized generously relative to total branch demand, so
        // this shouldn't trigger — but a demo script that crashes 15
        // branches in is worse than one that logs a skip and keeps going.
        console.error(
          `  Branch ${branchIndex + 1} batch ${batch + 1} failed, skipping:`,
          error instanceof Error ? error.message : error,
        );
      }
    }

    // ~50% of this branch's distinct products get 1-4 more lots layered on
    // top of their primary order below, so inventory actually shows several
    // simultaneous, non-empty lots for the same product at the same branch
    // — not just one. Bundled into at most a handful of extra orders (one
    // per round, covering every flagged product still owed a lot that
    // round), not one order per product — keeps this from multiplying the
    // branch-order count by 50+.
    const extraLotCounts = new Map<number, number>();
    for (const pId of distinctForBranch) {
      extraLotCounts.set(
        pId,
        branchMinStockFlagged.has(pId)
          ? 0
          : Math.random() < 0.5
            ? 0
            : randInt(1, 4),
      );
    }
    const maxExtraRounds = Math.max(0, ...extraLotCounts.values());

    for (let round = 0; round < maxExtraRounds; round++) {
      const roundPIds = [...distinctForBranch].filter(
        (pId) => (extraLotCounts.get(pId) ?? 0) > round,
      );
      if (roundPIds.length === 0) continue;

      const items = roundPIds.map((pId) => ({ pId, amount: randInt(10, 40) }));

      // Nearer-expiry each round (25/20/15/10 days, give or take), and
      // nearer than this product's normal bulk restock (shortest is 30
      // days) — so FEFO draws this round's request entirely from a lot
      // created just for it. Without this, every round would keep drawing
      // from whichever bulk lot is already nearest-expiry, and every
      // "extra" lot would end up carrying that same lot's expiredDate —
      // multiple rows, but not actually distinguishable batches.
      const expiresInDays = 25 - round * 5 + randInt(0, 2);
      await ordersHqService.create(hqOrderUser().id, {
        items: items.map(({ pId, amount }) => {
          const p = productById.get(pId)!;
          return {
            pId,
            supplierId: p.supplierId,
            amount,
            expiredDate: daysFromNow(expiresInDays).toISOString(),
            costPrice: Math.max(
              1,
              Math.round((p.price * randInt(50, 75)) / 100),
            ),
          };
        }),
      });

      const requester = pickOne(managers);

      try {
        const created = await ordersBranchService.create(
          requester.id,
          branchId,
          { items },
        );
        await ordersBranchService.approve(created.lotId, hqOrderUser().id);
        await ordersBranchService.receive(created.lotId, branchId);

        totalBranchOrders += 1;
        totalBranchLines += items.length;
        branchOrderCounts.set(
          branchId,
          (branchOrderCounts.get(branchId) ?? 0) + 1,
        );
      } catch (error) {
        console.error(
          `  Branch ${branchIndex + 1} overlap round ${round + 1} failed, skipping:`,
          error instanceof Error ? error.message : error,
        );
      }
    }

    // A small slice of this branch's stock gets a lot that deliberately
    // expires within the week, so scanAlerts() finds a real branch-level
    // expire alert here too — not just min_stock. Placed right after this
    // branch's normal batches with nothing in between, so FEFO is
    // guaranteed to draw from the lot created a few lines below first:
    // every other lot for these products expires weeks/months further out.
    const expireEligible = [...distinctForBranch].filter(
      (pId) => !branchMinStockFlagged.has(pId),
    );
    const expireFlagCount = Math.max(
      1,
      Math.round(expireEligible.length * BRANCH_EXPIRE_RATIO),
    );
    const expireFlagged = shuffled(expireEligible).slice(0, expireFlagCount);

    if (expireFlagged.length > 0) {
      const expireAmount = randInt(5, 15);
      const topUpItems = expireFlagged.map((pId) => {
        const builtProduct = productById.get(pId)!;
        return {
          pId,
          supplierId: builtProduct.supplierId,
          amount: expireAmount,
          expiredDate: daysFromNow(
            randInt(EXPIRE_SOON_MIN_DAYS, EXPIRE_SOON_MAX_DAYS),
          ).toISOString(),
          costPrice: Math.max(
            1,
            Math.round((builtProduct.price * randInt(50, 75)) / 100),
          ),
        };
      });

      try {
        // Same amount on both sides, so approve() draws this branch's
        // request entirely from the lot just created, not spilling into
        // the branch's existing long-dated stock for the same product.
        await ordersHqService.create(hqOrderUser().id, { items: topUpItems });

        const requester = pickOne(managers);
        const created = await ordersBranchService.create(
          requester.id,
          branchId,
          {
            items: expireFlagged.map((pId) => ({
              pId,
              amount: expireAmount,
            })),
          },
        );
        await ordersBranchService.approve(created.lotId, hqOrderUser().id);
        await ordersBranchService.receive(created.lotId, branchId);

        totalBranchOrders += 1;
        totalBranchLines += topUpItems.length;
        branchOrderCounts.set(
          branchId,
          (branchOrderCounts.get(branchId) ?? 0) + 1,
        );
        branchExpireFlaggedCounts.set(branchId, expireFlagged.length);
      } catch (error) {
        console.error(
          `  Branch ${branchIndex + 1} near-expiry top-up failed, skipping:`,
          error instanceof Error ? error.message : error,
        );
      }
    }

    branchDistinctProducts.set(branchId, distinctForBranch);
    console.log(
      `  Branch ${String(branchIndex + 1).padStart(2, "0")}: ${distinctForBranch.size} distinct products across ${BATCHES_PER_BRANCH} lots, ` +
        `${expireFlagged.length} near-expiry, ${branchMinStockFlagged.size} under min stock`,
    );
  }

  const hqExpireFlagCount = Math.max(
    1,
    Math.round(PRODUCT_COUNT * HQ_EXPIRE_RATIO),
  );
  console.log(
    `Leaving ${hqExpireFlagCount} products with a soon-expiring, undistributed HQ lot...`,
  );
  // Excludes the min-stock-flagged products — otherwise this top-up would
  // occasionally land on one of them and push its total back at/above
  // minStockHq, undoing the guarantee made for it above.
  const hqExpireFlagged = shuffled(
    products.filter((p) => !hqMinStockFlagged.has(p.pId)),
  ).slice(0, hqExpireFlagCount);
  // Placed after every branch order above, so nothing left to draw this
  // down — guaranteed remain > 0 and inside the 7-day window.
  await ordersHqService.create(hqOrderUser().id, {
    items: hqExpireFlagged.map((p) => ({
      pId: p.pId,
      supplierId: p.supplierId,
      amount: randInt(20, 60),
      expiredDate: daysFromNow(
        randInt(EXPIRE_SOON_MIN_DAYS, EXPIRE_SOON_MAX_DAYS),
      ).toISOString(),
      costPrice: Math.max(1, Math.round((p.price * randInt(50, 75)) / 100)),
    })),
  });

  console.log(
    `Simulating ${CUSTOMER_SALES_PER_BRANCH} cash sales per branch at the register...`,
  );
  let totalCustomerSales = 0;
  for (const branchId of branchIds) {
    const cashiers = branchCashiers.get(branchId)!;
    const stockedPIds = [...(branchDistinctProducts.get(branchId) ?? [])];
    if (stockedPIds.length === 0) continue;

    for (let i = 0; i < CUSTOMER_SALES_PER_BRANCH; i++) {
      const cashier = pickOne(cashiers);
      const pId = pickOne(stockedPIds);

      try {
        await ordersCustomerService.create(cashier.id, branchId, {
          paymentMethod: "cash",
          items: [{ pId, quantity: randInt(1, 5) }],
        });
        totalCustomerSales += 1;
      } catch (error) {
        // A line can occasionally outrun what's left after earlier sales
        // drew the same product down — skip it, same reasoning as above.
        console.error(
          `  Customer sale failed for product ${pId}, skipping:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  }

  console.log("Running notificationService.scanAlerts()...");
  const scan = await notificationService.scanAlerts();

  // Confirms the near-expiry top-ups above actually surface as real alerts
  // — scanAlerts()'s return value only reports counts *opened this scan*,
  // not what's currently open, so this re-reads the same way the original
  // seed-demo.ts verifies itself: through the real read path, not a guess.
  // `.total` (not `.result.length`) — these endpoints are paginated now, and
  // branch min_stock alone can run into the hundreds, well past one page.
  const { total: hqExpireAlertsTotal } =
    await notificationService.listHqExpire();
  const branchExpireCounts = new Map<number, number>();
  for (const branchId of branchIds) {
    const { total } = await notificationService.listBranchExpire(
      hqUsers[0],
      branchId,
    );
    branchExpireCounts.set(branchId, total);
  }
  const totalBranchExpireAlerts = [...branchExpireCounts.values()].reduce(
    (sum, n) => sum + n,
    0,
  );

  // Same real-read-path confirmation for the deliberately-under-threshold
  // products above.
  const { total: hqMinStockAlertsTotal } =
    await notificationService.listHqMinStock();
  const branchMinStockCounts = new Map<number, number>();
  for (const branchId of branchIds) {
    const { total } = await notificationService.listBranchMinStock(
      hqUsers[0],
      branchId,
    );
    branchMinStockCounts.set(branchId, total);
  }
  const totalBranchMinStockAlerts = [...branchMinStockCounts.values()].reduce(
    (sum, n) => sum + n,
    0,
  );

  // Confirms the overlap rounds above actually land as simultaneous,
  // non-empty lots — not just inserted rows one of which immediately got
  // drawn to zero. Counts (scope, product) pairs with more than one lot
  // that still has stock left, straight from the tables the inventory
  // endpoints themselves read.
  const [hqMultiLotProducts, branchMultiLotPairs] = await Promise.all([
    db
      .select({ pId: headOrderDetail.pId })
      .from(headOrderDetail)
      .innerJoin(order, eq(order.lotId, headOrderDetail.lotId))
      .where(
        and(
          eq(order.orderType, "hq"),
          eq(order.status, "approved"),
          gt(headOrderDetail.remain, 0),
        ),
      )
      .groupBy(headOrderDetail.pId)
      .having(sql`count(*) > 1`),
    db
      .select({
        branchId: branchOrderDetail.branchId,
        pId: branchOrderDetail.pId,
      })
      .from(branchOrderDetail)
      .where(gt(branchOrderDetail.remain, 0))
      .groupBy(branchOrderDetail.branchId, branchOrderDetail.pId)
      .having(sql`count(*) > 1`),
  ]);

  const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);

  // --- Verify the scale requirements actually landed ------------------------
  const shortfalls = branchIds.filter((branchId) => {
    const distinct = branchDistinctProducts.get(branchId)?.size ?? 0;
    const orders = branchOrderCounts.get(branchId) ?? 0;
    const expireAlerts = branchExpireCounts.get(branchId) ?? 0;
    const minStockAlerts = branchMinStockCounts.get(branchId) ?? 0;
    return (
      distinct < 100 || orders < 10 || expireAlerts < 1 || minStockAlerts < 1
    );
  });
  const noHqExpireAlerts = hqExpireAlertsTotal === 0;
  const noHqMinStockAlerts = hqMinStockAlertsTotal === 0;

  console.log("\n=== Seed summary ===");
  console.log(`Suppliers: ${supplierIds.length}`);
  console.log(`Products: ${products.length}`);
  console.log(`Categories: ${categoryRows.length}`);
  console.log(`Branches: ${branchIds.length}`);
  console.log(
    `Users: ${hqUsers.length} HQ, ${BRANCH_COUNT * MANAGERS_PER_BRANCH} branch managers, ${BRANCH_COUNT * CASHIERS_PER_BRANCH} cashiers`,
  );
  console.log(
    `Branch orders ("lots"): ${totalBranchOrders} total, ${(totalBranchOrders / BRANCH_COUNT).toFixed(1)} avg/branch, ${totalBranchLines} line items`,
  );
  console.log(`Customer sales: ${totalCustomerSales}`);
  console.log(
    `Products with 2+ simultaneous non-empty lots: ${hqMultiLotProducts.length}/${products.length} at HQ, ` +
      `${branchMultiLotPairs.length} (branch, product) pairs across all branches`,
  );
  console.log(
    `Expire alerts now open: ${hqExpireAlertsTotal} HQ, ${totalBranchExpireAlerts} branch ` +
      `(${(totalBranchExpireAlerts / BRANCH_COUNT).toFixed(1)} avg/branch)`,
  );
  console.log(
    `Min_stock alerts now open: ${hqMinStockAlertsTotal} HQ, ${totalBranchMinStockAlerts} branch ` +
      `(${(totalBranchMinStockAlerts / BRANCH_COUNT).toFixed(1)} avg/branch)`,
  );
  console.log(
    `scanAlerts() this run: opened ${scan.hqExpireOpened} HQ + ${scan.branchExpireOpened} branch expire alerts ` +
      `(checked ${scan.hqMinStockChecked} HQ + ${scan.branchMinStockChecked} branch/product pairs for min_stock)`,
  );
  console.log(`Elapsed: ${elapsedSeconds}s`);
  console.log(`\nAll accounts share the password: ${SCALE_PASSWORD}`);
  console.log(`Sign in as HQ: hq01.scale@racha-se.local`);
  console.log(
    `Sign in as a branch manager: branch01.manager1.scale@racha-se.local`,
  );
  console.log(`Sign in as a cashier: branch01.cashier1.scale@racha-se.local`);

  if (shortfalls.length > 0 || noHqExpireAlerts || noHqMinStockAlerts) {
    if (shortfalls.length > 0) {
      console.error(
        `\n${shortfalls.length} branch(es) ended up under the minimum ` +
          "(100 distinct products / 10 lots / 1 expire alert / 1 min_stock " +
          "alert) — check the skip warnings above (likely HQ ran short of " +
          "stock for a product).",
      );
    }
    if (noHqExpireAlerts) {
      console.error(
        "\nNo HQ expire alerts ended up open — check for errors above.",
      );
    }
    if (noHqMinStockAlerts) {
      console.error(
        "\nNo HQ min_stock alerts ended up open — check for errors above.",
      );
    }
    process.exit(1);
  }

  process.exit(0);
}

await main();
