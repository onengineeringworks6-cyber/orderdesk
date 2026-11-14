// =============== MODULES =============================
const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
// =====================================================

// ================ BASIC APP ==========================
const app = express();
const port = 3000;
app.use(express.json({ limit: '5mb' })); // raised from the default 100kb so compressed order photos can upload
app.use(express.static(path.join(__dirname, '..', 'static')));
// =====================================================

// DATABASE CONNECTION
// NOTE: left exactly as you currently have it deployed, so this update doesn't
// accidentally break your live site. Switching to an environment variable is
// still worth doing later, but as its own separate, deliberate step.
mongoose.connect(process.env.MONGO_URI || "mongodb+srv://onengineeringworks6:VAoDEw90cQoK36qT@cluster0.n5jpr.mongodb.net/?appName=Cluster0");

// USER MODEL
const admin = mongoose.model("Admin", {
  username: {
    type: String,
    required: true
  },
  password: {
    type: String,
    required: true
  },
  // "admin" sees and manages everything. "worker" can view orders and
  // update Status/Stage/Photos, but never sees money figures and can't
  // create, edit, or delete anything.
  // Legacy flag — kept for backward compatibility with old accounts and
  // as a fallback. The real source of truth going forward is RoleId below.
  role: {
    type: String,
    enum: ["admin", "worker"],
    default: "admin"
  },
  // The custom (or built-in Owner/Admin/Worker) role this person holds.
  RoleId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Role",
    default: null
  },
  // Account lockout after repeated failed logins. Stored in the database
  // (not in server memory) so it still works correctly on Vercel, where
  // each request can hit a different, freshly-started instance.
  failedAttempts: {
    type: Number,
    default: 0
  },
  lockUntil: {
    type: Date,
    default: null
  }
});

// Secret used to sign login sessions. Same tradeoff as the Mongo URI below —
// this fallback keeps the app working out of the box, but for real use you
// should set JWT_SECRET in your Vercel environment variables to a long
// random string, so sessions can't be forged by anyone who reads this code.
const JWT_SECRET = process.env.JWT_SECRET || "orderdesk-dev-secret-change-me";

//..........................ROLES (custom, Discord-style)..................
// Three built-in ranks anchor the hierarchy and can never be deleted or
// renamed: Worker (lowest), Admin (full access, same as "the old admin
// role"), and Owner — more powerful than any role, including Admin.
// Anyone can create roles in between (or above Admin, below Owner) and
// decide exactly what each one can do and what color it shows as.
const RANK = { OWNER: 1000, ADMIN: 900, WORKER: 100 };
const PERM_KEYS = ["viewFinancials", "manageOrders", "manageClients", "manageProducts", "manageQuotes", "manageEmployees", "manageTeam", "manageRoles"];
function sanitizePerms(input) {
  const out = {};
  PERM_KEYS.forEach(k => { out[k] = !!(input && input[k]); });
  return out;
}
const ROLE_COLORS = ["#2f8f5b", "#1f7a8c", "#a0522d", "#8e44ad", "#c0392b", "#d68910", "#16a085", "#5d6a63"];
function randomRoleColor() { return ROLE_COLORS[Math.floor(Math.random() * ROLE_COLORS.length)]; }

const teamRole = mongoose.model("Role", new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  color: { type: String, default: "#5d6a63" },
  rank: { type: Number, required: true }, // higher number = more authority
  permissions: {
    viewFinancials: { type: Boolean, default: false },
    manageOrders: { type: Boolean, default: false },
    manageClients: { type: Boolean, default: false },
    manageProducts: { type: Boolean, default: false },
    manageQuotes: { type: Boolean, default: false },
    manageEmployees: { type: Boolean, default: false },
    manageTeam: { type: Boolean, default: false },
    manageRoles: { type: Boolean, default: false }
  },
  isSystem: { type: Boolean, default: false } // Owner / Admin / Worker — fixed, can't be edited or deleted
}));

// Creates the three built-in roles once, if they don't already exist.
// Safe to call repeatedly (e.g. on every cold start).
async function ensureSystemRoles() {
  const fullPerms = sanitizePerms({ viewFinancials: true, manageOrders: true, manageClients: true, manageProducts: true, manageQuotes: true, manageEmployees: true, manageTeam: true, manageRoles: true });
  const seeds = [
    { name: "Owner", color: "#e0b000", rank: RANK.OWNER, isSystem: true, permissions: fullPerms },
    { name: "Admin", color: "#2f8f5b", rank: RANK.ADMIN, isSystem: true, permissions: fullPerms },
    { name: "Worker", color: "#5d6a63", rank: RANK.WORKER, isSystem: true, permissions: sanitizePerms({}) }
  ];
  for (const s of seeds) {
    if (!(await teamRole.findOne({ name: s.name }))) await new teamRole(s).save();
  }
}
// One-time, self-healing migration: give every existing team member (who
// predates this feature and has no RoleId yet) a real role, based on their
// old admin/worker flag. The very first account on the system becomes
// Owner, since it's the one that originally set everything up.
async function migrateLegacyRoles() {
  const [ownerRole, adminRole, workerRole] = await Promise.all([
    teamRole.findOne({ name: "Owner" }), teamRole.findOne({ name: "Admin" }), teamRole.findOne({ name: "Worker" })
  ]);
  if (!ownerRole || !adminRole || !workerRole) return;
  const ownerTaken = await admin.exists({ RoleId: ownerRole._id });
  const legacy = await admin.find({ RoleId: null }).sort({ _id: 1 });
  for (let i = 0; i < legacy.length; i++) {
    const u = legacy[i];
    if (!ownerTaken && i === 0 && u.role !== "worker") u.RoleId = ownerRole._id;
    else u.RoleId = u.role === "worker" ? workerRole._id : adminRole._id;
    await u.save();
  }
}
ensureSystemRoles().then(migrateLegacyRoles).catch(err => console.error("Could not set up roles:", err.message));

// Hierarchy rule (same idea as Discord): you can only create, edit, delete,
// or assign a role — or manage a team member — whose authority is strictly
// below your own. No one can touch their own rank or higher, which is what
// keeps Owner (and other people at your own level) safe from being edited.
function canManageRank(req, targetRank) {
  return req.user.rank > targetRank;
}

// Require a valid login token on every route this runs before.
async function requireAuth(req, res, next) {
  // Public, no-login order tracking links (/public/orders/:token) stay
  // open to anyone with the link — same principle as a courier tracking
  // page. They never touch req.user and the route itself only returns
  // non-financial fields.
  if (req.path.startsWith("/public/")) return next();

  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ message: "Please log in" });
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    // Look the user up every time, so removing or demoting someone takes
    // effect immediately instead of when their 30-day token runs out.
    const user = await admin.findById(decoded.id, "username role RoleId").populate("RoleId");
    if (!user) {
      return res.status(401).json({ message: "This account no longer exists" });
    }
    let roleDoc = user.RoleId;
    if (!roleDoc) {
      // Self-healing fallback in case migration hasn't run yet for this account.
      roleDoc = await teamRole.findOne({ name: user.role === "admin" ? "Admin" : "Worker" });
      if (roleDoc) { user.RoleId = roleDoc._id; await user.save(); }
    }
    const rank = roleDoc ? roleDoc.rank : (user.role === "admin" ? RANK.ADMIN : RANK.WORKER);
    req.user = {
      id: String(user._id),
      username: user.username,
      // Legacy admin/worker flag, kept exactly as before so every existing
      // check in this file (money fields, order actions, etc.) still works
      // unchanged: anyone at Admin rank or above counts as "admin".
      role: rank >= RANK.ADMIN ? "admin" : "worker",
      rank,
      perms: roleDoc ? roleDoc.permissions : sanitizePerms({}),
      roleId: roleDoc ? String(roleDoc._id) : null,
      roleName: roleDoc ? roleDoc.name : (user.role === "admin" ? "Admin" : "Worker"),
      roleColor: roleDoc ? roleDoc.color : "#5d6a63"
    };
    next();
  } catch (error) {
    return res.status(401).json({ message: "Your session has expired — please log in again" });
  }
}

// Require the logged-in user to be an admin (not a worker). Always used
// after requireAuth, so req.user is already set.
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ message: "Only an admin can do this" });
  }
  next();
}

// Shape an order for the caller: admins (and anyone granted the
// viewFinancials permission on a custom role) get everything, everyone
// else gets no money.
function forRole(req, orderDoc) {
  const canView = req.user.role === "admin" || (req.user.perms && req.user.perms.viewFinancials);
  return canView ? orderDoc : stripFinancials(orderDoc);
}

// Removes money-related fields from an order before it's sent to a
// non-admin user.
function stripFinancials(orderDoc) {
  const o = orderDoc.toObject ? orderDoc.toObject() : orderDoc;
  const { TotalValue, Advance, RemainingPayment, EstimatedCost, PurchaseCost, AdvanceHistory, History, Expenses, ...safe } = o;
  return safe;
}

//..........................ACTIVITY LOG (audit trail, admin-viewable)........
// A simple, append-only record of who did what and when, across the whole
// app — separate from each order's own History (which only covers that one
// order). Capped so it can't grow forever.
const activityLog = mongoose.model("ActivityLog", new mongoose.Schema({
  userId: { type: String, default: "" },
  username: { type: String, default: "system" },
  roleName: { type: String, default: "" },
  action: { type: String, required: true },   // short machine tag, e.g. "order.created"
  detail: { type: String, required: true },   // human-readable line
  date: { type: String, required: true }
}));
const ACTIVITY_LOG_CAP = 2000;

// Fire-and-forget — logging must never block or break the request it's
// attached to, so every failure is swallowed.
function logActivity(req, action, detail) {
  try {
    const entry = {
      userId: req && req.user ? req.user.id : "",
      username: req && req.user ? req.user.username : "system",
      roleName: req && req.user ? req.user.roleName : "",
      action,
      detail,
      date: new Date().toISOString()
    };
    activityLog.create(entry).then(async () => {
      const count = await activityLog.countDocuments();
      if (count > ACTIVITY_LOG_CAP) {
        const toTrim = await activityLog.find({}).sort({ date: 1 }).limit(count - ACTIVITY_LOG_CAP).select("_id");
        await activityLog.deleteMany({ _id: { $in: toTrim.map(t => t._id) } });
      }
    }).catch(err => console.error("Activity log write failed:", err.message));
  } catch (err) {
    console.error("Activity log failed:", err.message);
  }
}

app.get("/activity", requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 200, 500);
    const all = await activityLog.find({}).sort({ date: -1 }).limit(limit);
    res.status(200).json(all);
  } catch (error) {
    res.status(500).json({ message: "Error fetching activity log", error: error.message });
  }
});

// USER SIGNUP — bootstrap-only: works once, to create your first (and only)
// admin account, then locks itself automatically once any admin exists.
// This closes the previously-open public signup endpoint without needing
// any separate secret or manual step.
app.post('/signup', async (req, res) => {
  try {
    await ensureSystemRoles(); // make sure Owner/Admin/Worker exist before we assign one
    const existingCount = await admin.countDocuments();
    if (existingCount > 0) {
      return res.status(403).json({ message: "Signup is closed — an admin account already exists." });
    }

    const { username, password } = req.body;
    if (!username || !password || password.length < 6) {
      return res.status(400).json({ message: "Username and a password of at least 6 characters are required" });
    }

    const hashed = await bcrypt.hash(password, 10);
    // The very first account on the system is the one setting everything
    // up, so it becomes Owner — more powerful than any role, including Admin.
    const ownerRole = await teamRole.findOne({ name: "Owner" });
    const newAdmin = new admin({ username, password: hashed, role: "admin", RoleId: ownerRole ? ownerRole._id : null });

    await newAdmin.save();

    res.status(201).json({
      message: "Admin created successfully"
    });

  } catch (error) {
    res.status(500).json({
      message: "Error creating admin",
      error: error.message
    });
  }
});

// USER LOGIN
app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    const existingAdmin = await admin.findOne({ username });

    if (!existingAdmin) {
      return res.status(401).json({
        message: "Invalid username or password"
      });
    }

    if (existingAdmin.lockUntil && existingAdmin.lockUntil > new Date()) {
      const mins = Math.ceil((existingAdmin.lockUntil - new Date()) / 60000);
      return res.status(429).json({
        message: `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? "" : "s"}.`
      });
    }

    // Existing accounts may still have a plain-text password from before
    // hashing was added. Verify either way, and silently upgrade a
    // plain-text match to a proper hash so it migrates itself on next
    // login — no manual reset needed, no risk of being locked out.
    const looksHashed = /^\$2[aby]\$/.test(existingAdmin.password);
    let ok;
    if (looksHashed) {
      ok = await bcrypt.compare(password, existingAdmin.password);
    } else {
      ok = existingAdmin.password === password;
      if (ok) {
        existingAdmin.password = await bcrypt.hash(password, 10);
      }
    }

    if (!ok) {
      existingAdmin.failedAttempts = (existingAdmin.failedAttempts || 0) + 1;
      if (existingAdmin.failedAttempts >= 8) {
        existingAdmin.lockUntil = new Date(Date.now() + 15 * 60 * 1000);
        existingAdmin.failedAttempts = 0;
      }
      await existingAdmin.save();
      return res.status(401).json({
        message: "Invalid username or password"
      });
    }

    existingAdmin.failedAttempts = 0;
    existingAdmin.lockUntil = null;
    await existingAdmin.save();

    const role = existingAdmin.role || "admin";
    const token = jwt.sign(
      { id: existingAdmin._id.toString(), username: existingAdmin.username, role },
      JWT_SECRET,
      { expiresIn: "30d" }
    );

    // Include the real role's name/color/rank so the UI can show it right
    // away, without a second round trip. (Authorization itself never trusts
    // this response or the token — requireAuth re-checks from the DB.)
    let roleDoc = existingAdmin.RoleId ? await teamRole.findById(existingAdmin.RoleId) : null;
    if (!roleDoc) roleDoc = await teamRole.findOne({ name: role === "admin" ? "Admin" : "Worker" });

    logActivity(
      { user: { id: String(existingAdmin._id), username: existingAdmin.username, roleName: roleDoc ? roleDoc.name : role } },
      "auth.login", `${existingAdmin.username} logged in`
    );

    res.status(200).json({
      message: "Login successful",
      token,
      id: existingAdmin._id.toString(),
      username: existingAdmin.username,
      role,
      roleName: roleDoc ? roleDoc.name : (role === "admin" ? "Admin" : "Worker"),
      roleColor: roleDoc ? roleDoc.color : "#5d6a63",
      rank: roleDoc ? roleDoc.rank : (role === "admin" ? RANK.ADMIN : RANK.WORKER)
    });

  } catch (error) {
    res.status(500).json({
      message: "Server error",
      error: error.message
    });
  }
});

// Everything below this point requires a valid login token.
// /signup and /login (above) are the only routes that stay public.
app.use(requireAuth);


// ...............................ORDERS...............................
// ORDER MODEL
const orders = mongoose.model("Orders", {
  OrderID: {
    type: String,
    required: true,
    unique: true
  },

  // User-given label for the order, e.g. "Gate hinges - Sharma Steel"
  OrderName: {
    type: String,
    trim: true,
    default: ""
  },

  // Which kind of job this is. Drives which extra fields and stage
  // roadmap apply on the frontend.
  OrderType: {
    type: String,
    enum: ["New Order", "Labour Job", "Repairing", "Trading"],
    default: "New Order"
  },

  Client: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Client",
    required: true
  },

  ReceivingDate: {
    type: String,
    required: true
  },

  DeliveryDate: {
    type: String,
    required: true
  },

  Advance: {
    type: Number,
    required: true
  },

  AdvanceMode: {
    type: String,
    required: true
  },

  AdvanceDate: {
    type: String,
    required: true
  },

  TotalValue: {
    type: Number,
    required: true
  },

  // Repairing only: the quote given before work starts. TotalValue is
  // used as the actual final billed amount (kept generic so Advance /
  // RemainingPayment / Status work the same way for every order type).
  EstimatedCost: {
    type: Number,
    default: 0
  },

  // Trading only: what the item cost to buy in, so margin can be seen
  // against TotalValue (the selling price billed to the client).
  PurchaseCost: {
    type: Number,
    default: 0
  },

  // What the job actually is — machine/model for Repairing, material
  // description for Labour Job, item name for Trading, product for
  // New Order. Label shown for this changes per OrderType on the frontend.
  ItemDetails: {
    type: String,
    trim: true,
    default: ""
  },

  // Optional link to a catalog product — lets an order be filled in from
  // the Products list instead of typing ItemDetails freehand every time.
  Product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Product",
    default: null
  },

  // How many units of Product this order consumes — deducted from the
  // product's stock when the order is created, restored when it's deleted
  // or the product link/quantity changes. Meaningless when Product is null.
  Qty: {
    type: Number,
    default: 1
  },

  // Which team member is responsible for this job. The name is stored too,
  // so it can be shown to workers (who can't load the team list).
  AssignedTo: {
    type: String,
    default: ""
  },
  AssignedName: {
    type: String,
    default: ""
  },

  RemainingPayment: {
    type: Number,
    required: true
  },

  Status: {
    type: String,
    enum: ["Active", "Payment Due", "Closed"],
    default: "Active"
  },

  // Production/delivery roadmap step. Meaning depends on OrderType —
  // see STAGES below — the 6-step roadmap is shared by every order type.
  // varies by type (Trading only has 3 steps), enforced in the
  // /orders/:id/stage route rather than a fixed schema enum.
  Stage: {
    type: Number,
    default: 1
  },

  // History of every advance payment made against this order,
  // including the initial one taken when the order was created.
  AdvanceHistory: [{
    amount: Number,
    mode: String,
    date: String
  }],

  // Full audit trail — created, edited, stage moved, status changed,
  // advance added. Newest-last; frontend reverses for display.
  History: [{
    event: String,
    detail: String,
    date: String
  }],

  // Reference photos — e.g. machine on arrival for Repairing, material
  // received for Labour Job. Stored as compressed base64 data URLs
  // (compression happens client-side before upload).
  Photos: [{
    url: String,
    caption: String,
    date: String
  }],

  // Costs against this order beyond PurchaseCost (raw material, labour,
  // freight, etc.), so profit can be seen per order. Admin-only, same as
  // every other money field.
  Expenses: [{
    label: String,
    amount: Number,
    date: String
  }],

  // Random, unguessable token for the no-login client tracking link
  // (/public/orders/:token). Generated once at creation and never reused.
  PublicToken: {
    type: String,
    default: "",
    index: true
  },

  // Soft delete — "deleted" orders are hidden from normal views but kept
  // in the database so they can be restored from Recently Deleted.
  Deleted: {
    type: Boolean,
    default: false
  },
  DeletedAt: {
    type: String,
    default: null
  }
});

// Default 6-step roadmap, used to seed every order type and as a fallback
// if a roadmap document is somehow missing. Each order type's actual
// roadmap (customizable by an admin) lives in the Roadmap collection below.
const STAGES = ["Raw material", "Processing", "Completion of order", "To be delivered", "Delivered", "Money received"];
const ORDER_TYPES_LIST = ["New Order", "Labour Job", "Repairing", "Trading"];

const roadmap = mongoose.model("Roadmap", new mongoose.Schema({
  OrderType: { type: String, required: true, unique: true },
  stages: { type: [String], required: true }
}));

async function ensureRoadmaps() {
  for (const t of ORDER_TYPES_LIST) {
    if (!(await roadmap.findOne({ OrderType: t }))) {
      await new roadmap({ OrderType: t, stages: STAGES.slice() }).save();
    }
  }
}
ensureRoadmaps().catch(err => console.error("Could not seed roadmaps:", err.message));

// Looks up the actual (possibly customized) stage list for an order type.
async function stagesForType(orderType) {
  const r = await roadmap.findOne({ OrderType: orderType });
  return (r && r.stages && r.stages.length) ? r.stages : STAGES;
}

// Moves an order to its closed-out state: Closed if fully paid, otherwise
// "Payment Due" so unpaid work never silently disappears into Closed.
// markPaidIfDue only applies when explicitly requested (the "mark as paid"
// checkbox) — reaching the last stage on its own never fabricates a payment.
// maxStage is that order's own (possibly customized) roadmap length.
function applyClose(order, markPaidIfDue, maxStage) {
  if (order.RemainingPayment > 0 && markPaidIfDue) {
    const paid = order.RemainingPayment;
    const nowDate = new Date().toISOString();
    order.Advance += paid;
    order.RemainingPayment = 0;
    order.AdvanceHistory.push({ amount: paid, mode: "Marked as paid", date: nowDate.slice(0, 10) });
  }
  if (order.RemainingPayment > 0) {
    order.Status = "Payment Due";
    return "Production complete — payment still due, marked Payment Due";
  }
  order.Status = "Closed";
  order.Stage = maxStage || STAGES.length;
  return "Order closed — all stages complete and payment received";
}

app.post("/neworder", requireAdmin, async (req, res) => {
  try {

    const {
      OrderName,
      OrderType,
      Client,
      Product,
      ReceivingDate,
      DeliveryDate,
      Advance,
      AdvanceMode,
      AdvanceDate,
      TotalValue,
      EstimatedCost,
      PurchaseCost,
      ItemDetails,
      AssignedTo,
      Qty
    } = req.body;

    // Optional: assign the job to a team member right away.
    let assignedId = "", assignedName = "";
    if (AssignedTo && mongoose.isValidObjectId(AssignedTo)) {
      const member = await admin.findById(AssignedTo, "username");
      if (member) { assignedId = String(member._id); assignedName = member.username; }
    }

    // Don't trust the form alone — validate the money on the server too.
    const totalNum = Number(TotalValue), advNum = Number(Advance);
    if (!Number.isFinite(totalNum) || !Number.isFinite(advNum) || totalNum < 0 || advNum < 0) {
      return res.status(400).json({ message: "Total value and advance must be valid, non-negative numbers" });
    }
    if (advNum > totalNum) {
      return res.status(400).json({ message: "Advance cannot be more than the total value" });
    }

    const VALID_ORDER_TYPES = ["New Order", "Labour Job", "Repairing", "Trading"];
    const type = VALID_ORDER_TYPES.includes(OrderType) ? OrderType : "New Order";

    // Count existing orders
    const yearPrefix = `ORD-${new Date().getFullYear()}-`;
    // Base the next number on the highest existing order number for this year,
    // not a document count — a count can go backward after deletions and
    // collide with an OrderID that still exists (unique constraint failure).
    const latest = await orders.findOne({ OrderID: { $regex: `^${yearPrefix}` } }).sort({ OrderID: -1 });
    let nextNum = 1;
    if (latest) {
      const n = parseInt(latest.OrderID.slice(yearPrefix.length), 10);
      if (!isNaN(n)) nextNum = n + 1;
    }

    // Generate human-readable ID
    const OrderID = `${yearPrefix}${String(nextNum).padStart(4, "0")}`;

    const linkedProduct = Product && Product.trim() ? Product : null;
    let qtyNum = Number(Qty);
    if (!Number.isFinite(qtyNum) || qtyNum <= 0) qtyNum = 1;

    const now = new Date().toISOString();
    const newOrder = new orders({
      OrderID,
      OrderName: (OrderName || "").trim() || OrderID,
      OrderType: type,
      Client,
      PublicToken: crypto.randomBytes(16).toString("hex"),
      Product: linkedProduct,
      Qty: qtyNum,
      AssignedTo: assignedId,
      AssignedName: assignedName,
      ReceivingDate,
      DeliveryDate,
      Advance,
      AdvanceMode,
      AdvanceDate,
      TotalValue,
      EstimatedCost: EstimatedCost || 0,
      PurchaseCost: PurchaseCost || 0,
      ItemDetails: (ItemDetails || "").trim(),
      RemainingPayment: totalNum - advNum,
      AdvanceHistory: Advance > 0 ? [{ amount: Advance, mode: AdvanceMode, date: AdvanceDate }] : [],
      History: [
        { event: "Created", detail: `Order created as ${type}`, date: now },
        ...(assignedName ? [{ event: "Assigned", detail: `Assigned to ${assignedName}`, date: now }] : []),
        ...(Advance > 0 ? [{ event: "Payment", detail: `Advance of ₹${Advance} recorded (${AdvanceMode})`, date: now }] : [])
      ]
    });

    await newOrder.save();
    if (linkedProduct) await adjustStock(linkedProduct, -qtyNum);
    logActivity(req, "order.created", `Created order ${OrderID} (${type}) for ${newOrder.OrderName}`);

    res.status(201).json({
      message: "Order created successfully",
      order: newOrder
    });

  } catch (error) {
    res.status(500).json({
      message: "Error creating order",
      error: error.message
    });
  }
});

// GETTING ALL THE ORDERS (excludes soft-deleted)
app.get('/orders', async (req, res) => {
  try {
    const allorders = await orders.find({ Deleted: { $ne: true } });

    const canView = req.user.role === "admin" || (req.user.perms && req.user.perms.viewFinancials);
    res.status(200).json(
      canView ? allorders : allorders.map(stripFinancials)
    );

  } catch (error) {
    res.status(500).json({
      message: "Error fetching orders",
      error: error.message
    });
  }
});

// GETTING SOFT-DELETED ORDERS (Recently Deleted)
app.get('/orders/deleted', requireAdmin, async (req, res) => {
  try {
    const deleted = await orders.find({ Deleted: true }).sort({ DeletedAt: -1 });
    res.status(200).json(deleted);
  } catch (error) {
    res.status(500).json({ message: "Error fetching deleted orders", error: error.message });
  }
});

// EDIT AN ORDER
app.patch('/orders/:id', requireAdmin, async (req, res) => {
  try {
    const order = await orders.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    const { OrderName, ReceivingDate, DeliveryDate, TotalValue, EstimatedCost, PurchaseCost, ItemDetails, Product, Qty } = req.body;
    const changes = [];

    // Stock sync: figure out old vs new (Product, Qty) and move the
    // difference. Done as "restore old, then deduct new" so a product swap
    // or a quantity change both settle correctly in one pass.
    const oldProduct = order.Product ? String(order.Product) : null;
    const oldQty = order.Qty || 1;
    let newProduct = oldProduct;
    if (Product !== undefined) {
      newProduct = Product && Product.trim() ? Product : null;
      order.Product = newProduct;
    }
    let newQty = oldQty;
    if (Qty !== undefined) {
      const n = Number(Qty);
      newQty = (Number.isFinite(n) && n > 0) ? n : 1;
      order.Qty = newQty;
    }
    if (newProduct !== oldProduct || newQty !== oldQty) {
      if (oldProduct) await adjustStock(oldProduct, oldQty);       // give back old
      if (newProduct) await adjustStock(newProduct, -newQty);      // take new
    }
    if (OrderName !== undefined && OrderName.trim() && OrderName.trim() !== order.OrderName) {
      changes.push(`name → "${OrderName.trim()}"`);
      order.OrderName = OrderName.trim();
    }
    if (ReceivingDate !== undefined && ReceivingDate !== order.ReceivingDate) {
      changes.push(`receiving date → ${ReceivingDate}`);
      order.ReceivingDate = ReceivingDate;
    }
    if (DeliveryDate !== undefined && DeliveryDate !== order.DeliveryDate) {
      changes.push(`delivery date → ${DeliveryDate}`);
      order.DeliveryDate = DeliveryDate;
    }
    if (EstimatedCost !== undefined) order.EstimatedCost = Number(EstimatedCost) || 0;
    if (PurchaseCost !== undefined) order.PurchaseCost = Number(PurchaseCost) || 0;
    if (ItemDetails !== undefined && ItemDetails.trim() !== order.ItemDetails) {
      order.ItemDetails = ItemDetails.trim();
    }

    if (TotalValue !== undefined) {
      const newTotal = Number(TotalValue);
      if (newTotal < order.Advance) {
        return res.status(400).json({
          message: "Total value cannot be less than the advance already received"
        });
      }
      if (newTotal !== order.TotalValue) changes.push(`total value → ₹${newTotal}`);
      order.TotalValue = newTotal;
      order.RemainingPayment = newTotal - order.Advance;
    }

    if (changes.length) {
      order.History.push({ event: "Edited", detail: `Updated ${changes.join(", ")}`, date: new Date().toISOString() });
    }

    await order.save();
    if (changes.length) logActivity(req, "order.edited", `Edited order ${order.OrderID}: ${changes.join(", ")}`);

    res.status(200).json({ message: "Order updated", order });
  } catch (error) {
    res.status(500).json({ message: "Error updating order", error: error.message });
  }
});

// DELETE AN ORDER
// SOFT-DELETE AN ORDER (moved to Recently Deleted, not actually removed)
app.delete('/orders/:id', requireAdmin, async (req, res) => {
  try {
    const order = await orders.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }
    order.Deleted = true;
    order.DeletedAt = new Date().toISOString();
    order.History.push({ event: "Deleted", detail: "Order moved to Recently Deleted", date: order.DeletedAt });
    await order.save();
    if (order.Product) await adjustStock(order.Product, order.Qty || 1); // give stock back
    logActivity(req, "order.deleted", `Deleted order ${order.OrderID}`);
    res.status(200).json({ message: "Order deleted" });
  } catch (error) {
    res.status(500).json({ message: "Error deleting order", error: error.message });
  }
});

// RESTORE A SOFT-DELETED ORDER
app.post('/orders/:id/restore', requireAdmin, async (req, res) => {
  try {
    const order = await orders.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }
    order.Deleted = false;
    order.DeletedAt = null;
    order.History.push({ event: "Restored", detail: "Order restored from Recently Deleted", date: new Date().toISOString() });
    await order.save();
    if (order.Product) await adjustStock(order.Product, -(order.Qty || 1)); // take stock again
    logActivity(req, "order.restored", `Restored order ${order.OrderID}`);
    res.status(200).json({ message: "Order restored", order });
  } catch (error) {
    res.status(500).json({ message: "Error restoring order", error: error.message });
  }
});

// PERMANENTLY DELETE AN ORDER (only meant to be called from Recently Deleted)
app.delete('/orders/:id/forever', requireAdmin, async (req, res) => {
  try {
    const order = await orders.findByIdAndDelete(req.params.id);
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }
    res.status(200).json({ message: "Order permanently deleted" });
  } catch (error) {
    res.status(500).json({ message: "Error deleting order", error: error.message });
  }
});

// ADD AN ADVANCE PAYMENT TO AN EXISTING ORDER
app.post('/orders/:id/advance', requireAdmin, async (req, res) => {
  try {
    const { amount, mode, date } = req.body;
    const amt = Number(amount);

    if (!amt || amt <= 0) {
      return res.status(400).json({ message: "Enter a valid advance amount" });
    }

    const order = await orders.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    if (amt > order.RemainingPayment) {
      return res.status(400).json({
        message: `Amount cannot be more than the remaining payment (${order.RemainingPayment})`
      });
    }

    order.Advance += amt;
    order.RemainingPayment -= amt;
    order.AdvanceHistory.push({ amount: amt, mode, date });
    order.History.push({ event: "Payment", detail: `Advance of ₹${amt} added (${mode})`, date: new Date().toISOString() });

    await order.save();

    res.status(200).json({ message: "Advance recorded", order });
  } catch (error) {
    res.status(500).json({ message: "Error recording advance", error: error.message });
  }
});

// CHANGE ORDER STATUS
app.patch('/orders/:id/status', async (req, res) => {
  try {
    const { Status, markPaid } = req.body;

    if (!["Active", "Payment Due", "Closed"].includes(Status)) {
      return res.status(400).json({ message: "Status must be Active, Payment Due, or Closed" });
    }

    const order = await orders.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    let detail;
    if (Status === "Closed") {
      // Closing is conditional on payment: applyClose downgrades to
      // "Payment Due" by itself if the balance isn't actually zero.
      const stages = await stagesForType(order.OrderType);
      detail = applyClose(order, markPaid && req.user.role === "admin", stages.length);
    } else if (Status === "Payment Due") {
      order.Status = "Payment Due";
      detail = "Marked Payment Due";
    } else {
      order.Status = "Active";
      detail = "Reopened";
    }
    order.History.push({ event: "Status", detail, date: new Date().toISOString() });

    await order.save();
    logActivity(req, "order.status", `${order.OrderID}: ${detail}`);

    res.status(200).json({ message: "Order updated", order: forRole(req, order) });
  } catch (error) {
    res.status(500).json({ message: "Error updating order", error: error.message });
  }
});

// ASSIGN AN ORDER TO A TEAM MEMBER (admin only). Empty AssignedTo = unassign.
app.patch('/orders/:id/assign', requireAdmin, async (req, res) => {
  try {
    const { AssignedTo } = req.body;
    const order = await orders.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    let id = "", name = "";
    if (AssignedTo) {
      const member = mongoose.isValidObjectId(AssignedTo) ? await admin.findById(AssignedTo, "username") : null;
      if (!member) {
        return res.status(400).json({ message: "That team member no longer exists" });
      }
      id = String(member._id);
      name = member.username;
    }

    order.AssignedTo = id;
    order.AssignedName = name;
    order.History.push({ event: "Assigned", detail: name ? `Assigned to ${name}` : "Unassigned", date: new Date().toISOString() });
    await order.save();

    res.status(200).json({ message: "Assignment updated", order });
  } catch (error) {
    res.status(500).json({ message: "Error updating assignment", error: error.message });
  }
});

// ADD AN EXPENSE AGAINST AN ORDER (raw material, labour, freight, etc.)
app.post('/orders/:id/expenses', requireAdmin, async (req, res) => {
  try {
    const { label, amount } = req.body;
    const amt = Number(amount);

    if (!label || !label.trim() || !Number.isFinite(amt) || amt <= 0) {
      return res.status(400).json({ message: "A label and a positive amount are required" });
    }

    const order = await orders.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    const now = new Date().toISOString();
    order.Expenses.push({ label: label.trim(), amount: amt, date: now });
    order.History.push({ event: "Expense", detail: `${label.trim()}: ₹${amt}`, date: now });
    await order.save();

    res.status(201).json({ message: "Expense added", order });
  } catch (error) {
    res.status(500).json({ message: "Error adding expense", error: error.message });
  }
});

// REMOVE AN EXPENSE FROM AN ORDER
app.delete('/orders/:id/expenses/:expenseId', requireAdmin, async (req, res) => {
  try {
    const order = await orders.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }
    const before = order.Expenses.length;
    order.Expenses = order.Expenses.filter(e => String(e._id) !== req.params.expenseId);
    if (order.Expenses.length === before) {
      return res.status(404).json({ message: "Expense not found" });
    }
    order.History.push({ event: "Expense", detail: "Expense removed", date: new Date().toISOString() });
    await order.save();

    res.status(200).json({ message: "Expense removed", order });
  } catch (error) {
    res.status(500).json({ message: "Error removing expense", error: error.message });
  }
});

// UPDATE ORDER STAGE — the number of valid steps, and their labels, come
// from that order's own (possibly customized) roadmap.
app.patch('/orders/:id/stage', async (req, res) => {
  try {
    const order = await orders.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    const stages = await stagesForType(order.OrderType);
    const step = Number(req.body.Stage);
    const maxStage = stages.length;

    if (!Number.isInteger(step) || step < 1 || step > maxStage) {
      return res.status(400).json({ message: `Stage must be between 1 and ${maxStage}` });
    }

    order.Stage = step;
    let detail = `Moved to step ${step} of ${maxStage}: ${stages[step - 1]}`;
    // Reaching the last stage closes the order out by default — Closed if
    // paid, Payment Due if not. Never fabricates a payment on its own;
    // that only happens via the explicit checkbox.
    if (step === maxStage && order.Status !== "Closed") {
      detail += ` · ${applyClose(order, false, maxStage)}`;
    }
    order.History.push({ event: "Stage", detail, date: new Date().toISOString() });
    await order.save();

    res.status(200).json({ message: "Stage updated", order: forRole(req, order) });
  } catch (error) {
    res.status(500).json({ message: "Error updating stage", error: error.message });
  }
});

//..........................ROADMAPS (per order type, customizable)........
// GET all 4 order types' stage lists at once.
app.get("/roadmaps", async (req, res) => {
  try {
    const all = await roadmap.find({});
    const map = {};
    all.forEach(r => { map[r.OrderType] = r.stages; });
    ORDER_TYPES_LIST.forEach(t => { if (!map[t]) map[t] = STAGES; });
    res.status(200).json(map);
  } catch (error) {
    res.status(500).json({ message: "Error fetching roadmaps", error: error.message });
  }
});

// EDIT ONE ORDER TYPE'S ROADMAP (admin only). If the new list is shorter
// than before, any order of that type sitting past the new last stage is
// pulled back to the new last stage, so nothing points at a stage that no
// longer exists.
app.patch("/roadmaps/:orderType", requireAdmin, async (req, res) => {
  try {
    const orderType = req.params.orderType;
    if (!ORDER_TYPES_LIST.includes(orderType)) {
      return res.status(400).json({ message: "Unknown order type" });
    }
    const raw = req.body.stages;
    if (!Array.isArray(raw)) {
      return res.status(400).json({ message: "Stages must be a list" });
    }
    const cleaned = raw.map(s => String(s || "").trim()).filter(Boolean);
    if (!cleaned.length) {
      return res.status(400).json({ message: "Add at least one stage" });
    }
    if (cleaned.length > 20) {
      return res.status(400).json({ message: "Keep it to 20 stages or fewer" });
    }

    let r = await roadmap.findOne({ OrderType: orderType });
    if (!r) r = new roadmap({ OrderType: orderType, stages: cleaned });
    else r.stages = cleaned;
    await r.save();

    await orders.updateMany(
      { OrderType: orderType, Stage: { $gt: cleaned.length } },
      { Stage: cleaned.length }
    );

    logActivity(req, "roadmap.edited", `Updated ${orderType} roadmap (${cleaned.length} stages)`);
    res.status(200).json({ message: `${orderType} roadmap updated`, roadmap: r });
  } catch (error) {
    res.status(500).json({ message: "Error updating roadmap", error: error.message });
  }
});

// ADD A PHOTO TO AN ORDER (compressed client-side before upload)
app.post('/orders/:id/photos', async (req, res) => {
  try {
    const { url, caption } = req.body;

    if (!url || typeof url !== "string" || !/^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+\/=]+$/.test(url)) {
      return res.status(400).json({ message: "A valid image is required" });
    }
    if (url.length > 1_800_000) {
      return res.status(400).json({ message: "Photo is too large — please retake it and try again" });
    }

    const order = await orders.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    const now = new Date().toISOString();
    order.Photos.push({ url, caption: (caption || "").trim(), date: now });
    order.History.push({ event: "Photo", detail: caption ? `Photo added: ${caption}` : "Photo added", date: now });
    await order.save();

    res.status(201).json({ message: "Photo added", order: forRole(req, order) });
  } catch (error) {
    res.status(500).json({ message: "Error adding photo", error: error.message });
  }
});

// DELETE A PHOTO FROM AN ORDER
app.delete('/orders/:id/photos/:photoId', requireAdmin, async (req, res) => {
  try {
    const order = await orders.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    const before = order.Photos.length;
    order.Photos = order.Photos.filter(p => String(p._id) !== req.params.photoId);
    if (order.Photos.length === before) {
      return res.status(404).json({ message: "Photo not found" });
    }
    order.History.push({ event: "Photo", detail: "Photo removed", date: new Date().toISOString() });
    await order.save();

    res.status(200).json({ message: "Photo removed", order });
  } catch (error) {
    res.status(500).json({ message: "Error removing photo", error: error.message });
  }
});

// GET (OR LAZILY CREATE) AN ORDER'S NO-LOGIN TRACKING LINK TOKEN
// Older orders created before this feature existed won't have one yet —
// generated here on first request instead of a one-off migration script.
app.post('/orders/:id/public-link', requireAdmin, async (req, res) => {
  try {
    const order = await orders.findById(req.params.id);
    if (!order) return res.status(404).json({ message: "Order not found" });
    if (!order.PublicToken) {
      order.PublicToken = crypto.randomBytes(16).toString("hex");
      await order.save();
    }
    res.status(200).json({ token: order.PublicToken });
  } catch (error) {
    res.status(500).json({ message: "Error creating tracking link", error: error.message });
  }
});

// PUBLIC, NO-LOGIN ORDER TRACKING — exempted from requireAuth above.
// Returns only what a client should see: never money, never other orders,
// never anything about who's working on it internally.
app.get('/public/orders/:token', async (req, res) => {
  try {
    const order = await orders.findOne({ PublicToken: req.params.token, Deleted: { $ne: true } }).populate("Client", "name");
    if (!order) return res.status(404).json({ message: "This tracking link is invalid or has expired." });

    const stages = await stagesForType(order.OrderType);
    res.status(200).json({
      OrderID: order.OrderID,
      OrderName: order.OrderName,
      OrderType: order.OrderType,
      ClientName: order.Client ? order.Client.name : "",
      Status: order.Status,
      Stage: order.Stage,
      Stages: stages,
      ReceivingDate: order.ReceivingDate,
      DeliveryDate: order.DeliveryDate,
      Photos: (order.Photos || []).map(p => ({ url: p.url, caption: p.caption, date: p.date })),
      // Only non-money history events, in client-friendly language.
      Updates: (order.History || [])
        .filter(h => ["Created", "Status", "Photo"].includes(h.event))
        .map(h => ({ detail: h.detail, date: h.date }))
    });
  } catch (error) {
    res.status(500).json({ message: "Error loading tracking info", error: error.message });
  }
});

// ---------------------------CLIENT-----------------------------
// CLIENT SCHEMA
const client = mongoose.model("Client", {
  name: {
    type: String,
    required: true,
    trim: true
  },

  // Optional so a client can be quick-added by name alone from the New
  // Order form, then filled in properly later from the Clients page.
  Add: {
    type: String,
    default: "",
    trim: true
  },

  Phone: {
    type: String,
    default: "",
    trim: true
  },

  // Soft delete — same pattern as Orders.
  Deleted: {
    type: Boolean,
    default: false
  },
  DeletedAt: {
    type: String,
    default: null
  }
});

// ADDING NEW CLIENT
app.post("/newclient", requireAdmin, async (req, res) => {
  try {

    const { name, Add, Phone } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({
        message: "Name is required"
      });
    }

    const phone = (Phone || "").trim();

    // Phone and address are optional — a client can be quick-added by name
    // alone and completed later. But if a phone IS given, it still has to
    // be valid and unique.
    if (phone) {
      if (!/^\d{10}$/.test(phone)) {
        return res.status(400).json({
          message: "Phone number must be 10 digits"
        });
      }
      const existingClient = await client.findOne({ Phone: phone });
      if (existingClient) {
        return res.status(409).json({
          message: "Client with this phone number already exists"
        });
      }
    }

    const newClient = new client({
      name: name.trim(),
      Add: (Add || "").trim(),
      Phone: phone
    });

    await newClient.save();
    logActivity(req, "client.created", `Added client ${newClient.name}`);

    res.status(201).json({
      message: "Client created successfully",
      client: newClient
    });

  } catch (error) {

    res.status(500).json({
      message: "Error creating client",
      error: error.message
    });

  }
});

// EDIT A CLIENT
app.patch("/clients/:id", requireAdmin, async (req, res) => {
  try {
    const { name, Add, Phone } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ message: "Name is required" });
    }

    const phone = (Phone || "").trim();
    if (phone) {
      if (!/^\d{10}$/.test(phone)) {
        return res.status(400).json({ message: "Phone number must be 10 digits" });
      }
      const duplicate = await client.findOne({ Phone: phone, _id: { $ne: req.params.id } });
      if (duplicate) {
        return res.status(409).json({ message: "Another client already uses this phone number" });
      }
    }

    const updated = await client.findByIdAndUpdate(
      req.params.id,
      { name: name.trim(), Add: (Add || "").trim(), Phone: phone },
      { new: true }
    );

    if (!updated) {
      return res.status(404).json({ message: "Client not found" });
    }

    res.status(200).json({ message: "Client updated", client: updated });
  } catch (error) {
    res.status(500).json({ message: "Error updating client", error: error.message });
  }
});

// DELETE A CLIENT
// SOFT-DELETE A CLIENT (moved to Recently Deleted, not actually removed)
app.delete("/clients/:id", requireAdmin, async (req, res) => {
  try {
    const existingOrders = await orders.countDocuments({ Client: req.params.id, Deleted: { $ne: true } });
    if (existingOrders > 0) {
      return res.status(409).json({
        message: "This client still has orders on record. Delete those orders first."
      });
    }

    const c = await client.findById(req.params.id);
    if (!c) {
      return res.status(404).json({ message: "Client not found" });
    }
    c.Deleted = true;
    c.DeletedAt = new Date().toISOString();
    await c.save();

    res.status(200).json({ message: "Client deleted" });
  } catch (error) {
    res.status(500).json({ message: "Error deleting client", error: error.message });
  }
});

// RESTORE A SOFT-DELETED CLIENT
app.post("/clients/:id/restore", requireAdmin, async (req, res) => {
  try {
    const c = await client.findById(req.params.id);
    if (!c) {
      return res.status(404).json({ message: "Client not found" });
    }
    c.Deleted = false;
    c.DeletedAt = null;
    await c.save();
    res.status(200).json({ message: "Client restored", client: c });
  } catch (error) {
    res.status(500).json({ message: "Error restoring client", error: error.message });
  }
});

// PERMANENTLY DELETE A CLIENT (only meant to be called from Recently Deleted)
app.delete("/clients/:id/forever", requireAdmin, async (req, res) => {
  try {
    const existingOrders = await orders.countDocuments({ Client: req.params.id });
    if (existingOrders > 0) {
      return res.status(409).json({
        message: "This client still has orders on record (including deleted ones). Permanently delete those orders first."
      });
    }
    const deleted = await client.findByIdAndDelete(req.params.id);
    if (!deleted) {
      return res.status(404).json({ message: "Client not found" });
    }
    res.status(200).json({ message: "Client permanently deleted" });
  } catch (error) {
    res.status(500).json({ message: "Error deleting client", error: error.message });
  }
});

// GET SOFT-DELETED CLIENTS (Recently Deleted)
app.get("/clients/deleted", requireAdmin, async (req, res) => {
  try {
    const deleted = await client.find({ Deleted: true }).sort({ DeletedAt: -1 });
    res.status(200).json(deleted);
  } catch (error) {
    res.status(500).json({ message: "Error fetching deleted clients", error: error.message });
  }
});

// GET ALL CLIENTS (excludes soft-deleted)
app.get("/allclients", async (req, res) => {
  try {

    const allclients = await client.find({ Deleted: { $ne: true } });

    const clients = await Promise.all(

      allclients.map(async (clientData) => {

        const clientOrders = await orders.find({
          Client: clientData._id,
          Deleted: { $ne: true }
        });

        const activeOrders = clientOrders.filter(
          order => order.Status === "Active"
        );

        const balanceDue = clientOrders.reduce(
          (total, order) => total + order.RemainingPayment,
          0
        );

        const isAdmin = req.user.role === "admin";

        return {

          _id: clientData._id,

          name: clientData.name,

          Add: clientData.Add,

          Phone: clientData.Phone,

          TotalOrders: clientOrders.length,

          ActiveOrders: activeOrders.length,

          BalanceDue: isAdmin ? balanceDue : undefined,

          Orders: isAdmin ? clientOrders.map(order => ({
            _id: order._id,
            OrderID: order.OrderID,
            TotalValue: order.TotalValue,
            Advance: order.Advance,
            RemainingPayment: order.RemainingPayment,
            ReceivingDate: order.ReceivingDate,
            DeliveryDate: order.DeliveryDate,
            AdvanceMode: order.AdvanceMode,
            AdvanceDate: order.AdvanceDate,
            Status: order.Status
          })) : undefined

        };

      })
    );

    res.status(200).json(clients);

  } catch (error) {

    res.status(500).json({
      message: "Error fetching clients",
      error: error.message
    });

  }
});

//..........................PRODUCTS..................................
// PRODUCT SCHEMA
const product = mongoose.model("Product", {

  ProductID: {
    type: String,
    required: true,
    unique: true
  },

  name: {
    type: String,
    required: true
  },

  desc: {
    type: String,
    required: true
  },

  category: {
    type: String,
    required: true
  },

  // Optional reference photo — taken or uploaded, compressed client-side
  // before upload (same data-URL convention as order photos).
  Photo: {
    type: String,
    default: ""
  },

  // Inventory — units currently on hand. Deducted automatically when an
  // order links this product (by its Qty), restored if that order is
  // deleted or its Product/Qty changes. Also adjustable directly (restock).
  stock: {
    type: Number,
    default: 0
  },
  unit: {
    type: String,
    trim: true,
    default: "pcs"
  },
  // Dashboard/Products page flags this product as low stock once `stock`
  // falls at or below this number. 0 = no alert.
  lowStockAlert: {
    type: Number,
    default: 0
  }

});

const PHOTO_RE = /^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+\/=]+$/;
function validPhoto(url) {
  if (!url) return true; // optional
  return typeof url === "string" && PHOTO_RE.test(url) && url.length <= 1_800_000;
}

// Adjust a product's stock by `delta` (positive = add, negative = deduct).
// Silently no-ops if productId is missing/invalid — stock tracking should
// never block an order from being saved.
async function adjustStock(productId, delta) {
  if (!productId || !delta || !mongoose.isValidObjectId(productId)) return;
  try {
    await product.findByIdAndUpdate(productId, { $inc: { stock: delta } });
  } catch (e) {
    console.error("Stock adjust failed:", e.message);
  }
}

// ADDING NEW PRODUCT
app.post("/addproduct", requireAdmin, async (req, res) => {

  try {

    const { name, desc, category, Photo, stock, unit, lowStockAlert } = req.body;

    // Required field validation
    if (!name || !desc || !category) {
      return res.status(400).json({
        message: "Name, description and category are required"
      });
    }
    if (!validPhoto(Photo)) {
      return res.status(400).json({ message: "Photo is invalid or too large — please retake it and try again" });
    }
    const stockNum = stock === undefined || stock === "" ? 0 : Number(stock);
    const lowNum = lowStockAlert === undefined || lowStockAlert === "" ? 0 : Number(lowStockAlert);
    if (!Number.isFinite(stockNum) || stockNum < 0) {
      return res.status(400).json({ message: "Stock must be a valid, non-negative number" });
    }
    if (!Number.isFinite(lowNum) || lowNum < 0) {
      return res.status(400).json({ message: "Low stock alert must be a valid, non-negative number" });
    }

    // Generate Product ID — always from the highest existing number,
    // never a plain count, so it can't collide after a deletion.
    const prefix = "PROD-";
    const latest = await product.findOne({ ProductID: { $regex: `^${prefix}` } }).sort({ ProductID: -1 });
    let num = 1;
    if (latest) {
      const n = parseInt(latest.ProductID.slice(prefix.length), 10);
      if (!isNaN(n)) num = n + 1;
    }
    const ProductID = `${prefix}${String(num).padStart(4, "0")}`;

    const newProduct = new product({

      ProductID,
      name,
      desc,
      category,
      Photo: Photo || "",
      stock: stockNum,
      unit: (unit || "pcs").trim() || "pcs",
      lowStockAlert: lowNum

    });

    await newProduct.save();
    logActivity(req, "product.created", `Added product ${newProduct.name}`);

    res.status(201).json({

      message: "Product added successfully",

      product: newProduct

    });

  } catch (error) {

    res.status(500).json({

      message: "Error adding product",

      error: error.message

    });
  }
});

// EDIT A PRODUCT (including adding/changing/removing its photo later)
app.patch("/products/:id", requireAdmin, async (req, res) => {
  try {
    const p = await product.findById(req.params.id);
    if (!p) {
      return res.status(404).json({ message: "Product not found" });
    }

    const { name, desc, category, Photo, stock, unit, lowStockAlert } = req.body;
    if (name !== undefined) {
      if (!name.trim()) return res.status(400).json({ message: "Name is required" });
      p.name = name.trim();
    }
    if (desc !== undefined) {
      if (!desc.trim()) return res.status(400).json({ message: "Description is required" });
      p.desc = desc.trim();
    }
    if (category !== undefined) {
      if (!category.trim()) return res.status(400).json({ message: "Category is required" });
      p.category = category.trim();
    }
    if (Photo !== undefined) {
      if (!validPhoto(Photo)) {
        return res.status(400).json({ message: "Photo is invalid or too large — please retake it and try again" });
      }
      p.Photo = Photo || "";
    }
    if (stock !== undefined) {
      const n = Number(stock);
      if (!Number.isFinite(n) || n < 0) return res.status(400).json({ message: "Stock must be a valid, non-negative number" });
      p.stock = n;
    }
    if (unit !== undefined) {
      p.unit = (unit || "pcs").trim() || "pcs";
    }
    if (lowStockAlert !== undefined) {
      const n = Number(lowStockAlert);
      if (!Number.isFinite(n) || n < 0) return res.status(400).json({ message: "Low stock alert must be a valid, non-negative number" });
      p.lowStockAlert = n;
    }

    await p.save();
    res.status(200).json({ message: "Product updated", product: p });
  } catch (error) {
    res.status(500).json({ message: "Error updating product", error: error.message });
  }
});

app.get("/products", async (req, res) => {
  try {

    const allProducts = await product.find({});

    res.status(200).json(allProducts);

  } catch (error) {

    res.status(500).json({
      message: "Error fetching products",
      error: error.message
    });

  }
});

//..........................EXPENSES (general business overhead).........................
// General, non-order-specific business expenses — rent, salaries, utilities,
// tools, marketing, etc. (Order-specific costs already live on each order's
// own Expenses sub-array.) Used by the dashboard to compute real profit
// (revenue generated minus every expense, order-level and general).
const expense = mongoose.model("Expense", {
  ExpenseID: { type: String, required: true, unique: true },
  label: { type: String, required: true, trim: true },
  amount: { type: Number, required: true },
  category: { type: String, trim: true, default: "General" },
  date: { type: String, required: true },
  notes: { type: String, trim: true, default: "" }
});

// Money data — same access rule as order financials: admins and anyone
// granted viewFinancials on a custom role can read; only admins can write.
function requireViewFinancials(req, res, next) {
  if (req.user.role === "admin" || (req.user.perms && req.user.perms.viewFinancials)) return next();
  return res.status(403).json({ message: "You don't have permission to view financial data" });
}

app.get("/expenses", requireViewFinancials, async (req, res) => {
  try {
    const all = await expense.find({}).sort({ date: -1 });
    res.status(200).json(all);
  } catch (error) {
    res.status(500).json({ message: "Error fetching expenses", error: error.message });
  }
});

app.post("/expenses", requireAdmin, async (req, res) => {
  try {
    const { label, amount, category, date, notes } = req.body;
    if (!label || !label.trim()) return res.status(400).json({ message: "A label is required" });
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ message: "Enter a valid amount" });
    if (!date) return res.status(400).json({ message: "A date is required" });

    const prefix = "EXP-";
    const latest = await expense.findOne({ ExpenseID: { $regex: `^${prefix}` } }).sort({ ExpenseID: -1 });
    let num = 1;
    if (latest) {
      const n = parseInt(latest.ExpenseID.slice(prefix.length), 10);
      if (!isNaN(n)) num = n + 1;
    }
    const ExpenseID = `${prefix}${String(num).padStart(4, "0")}`;

    const newExpense = new expense({
      ExpenseID,
      label: label.trim(),
      amount: amt,
      category: (category || "General").trim() || "General",
      date,
      notes: (notes || "").trim()
    });
    await newExpense.save();
    logActivity(req, "expense.created", `Added expense "${newExpense.label}" (₹${amt})`);

    res.status(201).json({ message: "Expense added", expense: newExpense });
  } catch (error) {
    res.status(500).json({ message: "Error adding expense", error: error.message });
  }
});

app.patch("/expenses/:id", requireAdmin, async (req, res) => {
  try {
    const e = await expense.findById(req.params.id);
    if (!e) return res.status(404).json({ message: "Expense not found" });

    const { label, amount, category, date, notes } = req.body;
    if (label !== undefined) {
      if (!label.trim()) return res.status(400).json({ message: "A label is required" });
      e.label = label.trim();
    }
    if (amount !== undefined) {
      const amt = Number(amount);
      if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ message: "Enter a valid amount" });
      e.amount = amt;
    }
    if (category !== undefined) e.category = (category || "General").trim() || "General";
    if (date !== undefined) e.date = date;
    if (notes !== undefined) e.notes = notes.trim();

    await e.save();
    res.status(200).json({ message: "Expense updated", expense: e });
  } catch (error) {
    res.status(500).json({ message: "Error updating expense", error: error.message });
  }
});

app.delete("/expenses/:id", requireAdmin, async (req, res) => {
  try {
    const removed = await expense.findByIdAndDelete(req.params.id);
    if (!removed) return res.status(404).json({ message: "Expense not found" });
    logActivity(req, "expense.deleted", `Deleted expense "${removed.label}"`);
    res.status(200).json({ message: "Expense deleted" });
  } catch (error) {
    res.status(500).json({ message: "Error deleting expense", error: error.message });
  }
});

//..........................QUOTATIONS (admin only).........................
const quote = mongoose.model("Quote", {
  QuoteID: { type: String, required: true, unique: true },
  Client: { type: mongoose.Schema.Types.ObjectId, ref: "Client", default: null },
  ProspectName: { type: String, trim: true, default: "" },
  ProspectPhone: { type: String, trim: true, default: "" },
  Description: { type: String, trim: true, default: "" },
  // Line items — each may reference a Product (snapshotting its name so the
  // quote still reads correctly if the product is later renamed/deleted),
  // or be a fully custom line. Price is always entered manually, per item.
  Items: [{
    Product: { type: mongoose.Schema.Types.ObjectId, ref: "Product", default: null },
    name: { type: String, trim: true, required: true },
    qty: { type: Number, default: 1 },
    price: { type: Number, required: true }
  }],
  Amount: { type: Number, required: true }, // = sum(qty * price) across Items, computed server-side
  ValidUntil: { type: String, default: "" },
  Status: { type: String, enum: ["Draft", "Sent", "Accepted", "Rejected", "Converted"], default: "Draft" },
  ConvertedOrderId: { type: mongoose.Schema.Types.ObjectId, ref: "Orders", default: null },
  // Edit history / audit trail — every create, edit and send is logged here.
  History: [{ event: String, detail: String, date: String }],
  CreatedAt: { type: String, default: () => new Date().toISOString() }
});

// Parses/validates the Items payload (sent as a JSON string from the
// client). Throws a plain Error with a user-facing message on bad input.
function parseQuoteItems(raw) {
  let items;
  if (typeof raw === "string") {
    try { items = JSON.parse(raw); } catch { throw new Error("Items are invalid — please re-add them"); }
  } else {
    items = raw;
  }
  if (!Array.isArray(items) || !items.length) {
    throw new Error("Add at least one item to the quotation");
  }
  return items.map(it => {
    const name = String((it && it.name) || "").trim();
    const price = Number(it && it.price);
    const qty = Number(it && it.qty) || 1;
    if (!name) throw new Error("Every item needs a name");
    if (!Number.isFinite(price) || price < 0) throw new Error(`Enter a valid price for "${name}"`);
    if (!Number.isFinite(qty) || qty <= 0) throw new Error(`Enter a valid quantity for "${name}"`);
    return { Product: (it && it.Product) || null, name, qty, price };
  });
}
function quoteItemsTotal(items) {
  return items.reduce((t, it) => t + it.price * it.qty, 0);
}

app.get("/quotes", requireAdmin, async (req, res) => {
  try {
    const all = await quote.find({}).sort({ CreatedAt: -1 });
    res.status(200).json(all);
  } catch (error) {
    res.status(500).json({ message: "Error fetching quotations", error: error.message });
  }
});

app.post("/quotes", requireAdmin, async (req, res) => {
  try {
    const { Client, ProspectName, ProspectPhone, Description, ValidUntil, Items } = req.body;

    let items;
    try { items = parseQuoteItems(Items); } catch (e) { return res.status(400).json({ message: e.message }); }
    const amt = quoteItemsTotal(items);

    if (!(Client && Client.trim()) && !(ProspectName && ProspectName.trim())) {
      return res.status(400).json({ message: "Pick a client or enter a prospect's name" });
    }

    const prefix = `QTE-${new Date().getFullYear()}-`;
    const latest = await quote.findOne({ QuoteID: { $regex: `^${prefix}` } }).sort({ QuoteID: -1 });
    let num = 1;
    if (latest) {
      const n = parseInt(latest.QuoteID.slice(prefix.length), 10);
      if (!isNaN(n)) num = n + 1;
    }
    const QuoteID = `${prefix}${String(num).padStart(4, "0")}`;
    const now = new Date().toISOString();

    const newQuote = new quote({
      QuoteID,
      Client: Client && Client.trim() ? Client : null,
      ProspectName: (ProspectName || "").trim(),
      ProspectPhone: (ProspectPhone || "").trim(),
      Description: (Description || "").trim(),
      Items: items,
      Amount: amt,
      ValidUntil: ValidUntil || "",
      History: [{ event: "Created", detail: `Quotation created with ${items.length} item${items.length === 1 ? "" : "s"}, total ₹${amt}`, date: now }]
    });
    await newQuote.save();
    logActivity(req, "quote.created", `Created quotation ${QuoteID} (₹${amt})`);

    res.status(201).json({ message: "Quotation created", quote: newQuote });
  } catch (error) {
    res.status(500).json({ message: "Error creating quotation", error: error.message });
  }
});

app.patch("/quotes/:id", requireAdmin, async (req, res) => {
  try {
    const q = await quote.findById(req.params.id);
    if (!q) {
      return res.status(404).json({ message: "Quotation not found" });
    }
    if (q.Status === "Converted") {
      return res.status(400).json({ message: "This quotation has already been converted to an order" });
    }

    const { Status, Description, ValidUntil, ProspectName, ProspectPhone, Items } = req.body;
    const now = new Date().toISOString();
    const changes = [];

    if (Status !== undefined) {
      if (!["Draft", "Sent", "Accepted", "Rejected"].includes(Status)) {
        return res.status(400).json({ message: "Invalid status" });
      }
      if (Status !== q.Status) { changes.push(`Status changed from ${q.Status} to ${Status}`); q.Status = Status; }
    }
    if (Items !== undefined) {
      let items;
      try { items = parseQuoteItems(Items); } catch (e) { return res.status(400).json({ message: e.message }); }
      const newAmt = quoteItemsTotal(items);
      if (newAmt !== q.Amount) changes.push(`Amount changed from ₹${q.Amount} to ₹${newAmt}`);
      changes.push(`Items updated (${items.length} item${items.length === 1 ? "" : "s"})`);
      q.Items = items;
      q.Amount = newAmt;
    }
    if (Description !== undefined && Description.trim() !== q.Description) {
      changes.push("Notes updated");
      q.Description = Description.trim();
    }
    if (ValidUntil !== undefined && (ValidUntil || "") !== (q.ValidUntil || "")) {
      changes.push(`Valid-until date changed`);
      q.ValidUntil = ValidUntil || "";
    }
    if (ProspectName !== undefined && ProspectName.trim() !== q.ProspectName) {
      changes.push("Prospect name updated");
      q.ProspectName = ProspectName.trim();
    }
    if (ProspectPhone !== undefined && ProspectPhone.trim() !== q.ProspectPhone) {
      changes.push("Prospect phone updated");
      q.ProspectPhone = ProspectPhone.trim();
    }

    if (changes.length) q.History.push({ event: "Edited", detail: changes.join("; "), date: now });

    await q.save();
    res.status(200).json({ message: "Quotation updated", quote: q });
  } catch (error) {
    res.status(500).json({ message: "Error updating quotation", error: error.message });
  }
});

// MARK A QUOTATION AS SENT TO THE CLIENT (logged separately from a manual status change)
app.post("/quotes/:id/send", requireAdmin, async (req, res) => {
  try {
    const q = await quote.findById(req.params.id);
    if (!q) {
      return res.status(404).json({ message: "Quotation not found" });
    }
    const now = new Date().toISOString();
    if (q.Status === "Draft") q.Status = "Sent";
    q.History.push({ event: "Sent", detail: "Quotation sent to client on WhatsApp", date: now });
    await q.save();
    logActivity(req, "quote.sent", `Sent quotation ${q.QuoteID}`);
    res.status(200).json({ message: "Marked as sent", quote: q });
  } catch (error) {
    res.status(500).json({ message: "Error marking quotation sent", error: error.message });
  }
});

app.delete("/quotes/:id", requireAdmin, async (req, res) => {
  try {
    const removed = await quote.findByIdAndDelete(req.params.id);
    if (!removed) {
      return res.status(404).json({ message: "Quotation not found" });
    }
    res.status(200).json({ message: "Quotation deleted" });
  } catch (error) {
    res.status(500).json({ message: "Error deleting quotation", error: error.message });
  }
});

// CONVERT A QUOTATION INTO A REAL ORDER
app.post("/quotes/:id/convert", requireAdmin, async (req, res) => {
  try {
    const q = await quote.findById(req.params.id);
    if (!q) {
      return res.status(404).json({ message: "Quotation not found" });
    }
    if (q.Status === "Converted") {
      return res.status(400).json({ message: "This quotation has already been converted" });
    }

    const clientId = (req.body.Client && req.body.Client.trim()) || (q.Client ? String(q.Client) : "");
    if (!clientId) {
      return res.status(400).json({ message: "Pick a client to convert this quotation into an order" });
    }
    const c = await client.findById(clientId);
    if (!c || c.Deleted) {
      return res.status(400).json({ message: "That client could not be found" });
    }

    const yearPrefix = `ORD-${new Date().getFullYear()}-`;
    const latestOrder = await orders.findOne({ OrderID: { $regex: `^${yearPrefix}` } }).sort({ OrderID: -1 });
    let nextNum = 1;
    if (latestOrder) {
      const n = parseInt(latestOrder.OrderID.slice(yearPrefix.length), 10);
      if (!isNaN(n)) nextNum = n + 1;
    }
    const OrderID = `${yearPrefix}${String(nextNum).padStart(4, "0")}`;
    const now = new Date().toISOString();
    const today = now.slice(0, 10);

    const itemsText = (q.Items && q.Items.length)
      ? q.Items.map(it => `${it.name}${it.qty > 1 ? ` x${it.qty}` : ""} — ₹${it.price}`).join(", ")
      : (q.Description || "");
    const orderName = q.Description || (q.Items && q.Items[0] && q.Items[0].name) || OrderID;

    const newOrder = new orders({
      OrderID,
      OrderName: orderName.slice(0, 60),
      OrderType: "New Order",
      Client: clientId,
      ReceivingDate: today,
      DeliveryDate: today,
      Advance: 0,
      AdvanceMode: "Cash",
      AdvanceDate: today,
      TotalValue: q.Amount,
      ItemDetails: itemsText,
      RemainingPayment: q.Amount,
      AdvanceHistory: [],
      History: [{ event: "Created", detail: `Order created from quotation ${q.QuoteID}`, date: now }]
    });
    await newOrder.save();

    q.Status = "Converted";
    q.ConvertedOrderId = newOrder._id;
    q.History.push({ event: "Converted", detail: `Converted to order ${OrderID}`, date: now });
    await q.save();
    logActivity(req, "quote.converted", `Converted quotation ${q.QuoteID} to order ${OrderID}`);

    res.status(201).json({ message: "Quotation converted to order", order: newOrder, quote: q });
  } catch (error) {
    res.status(500).json({ message: "Error converting quotation", error: error.message });
  }
});

//..........................INVOICES / GST BILLS (admin only).................
// A formal bill generated against a specific order — separate from a
// Quotation (which is given before work starts). Snapshots the client and
// order details at the time it's generated so the invoice stays correct
// even if the order or client is edited afterwards.
const invoice = mongoose.model("Invoice", {
  InvoiceID: { type: String, required: true, unique: true },
  Order: { type: mongoose.Schema.Types.ObjectId, ref: "Orders", required: true },
  Client: { type: mongoose.Schema.Types.ObjectId, ref: "Client", default: null },

  ClientName: { type: String, trim: true, default: "" },
  ClientAddress: { type: String, trim: true, default: "" },
  ClientPhone: { type: String, trim: true, default: "" },
  ClientGSTIN: { type: String, trim: true, default: "" },

  OrderTitle: { type: String, trim: true, default: "" },
  Description: { type: String, trim: true, default: "" },

  Subtotal: { type: Number, required: true },
  GSTEnabled: { type: Boolean, default: false },
  GSTRate: { type: Number, default: 18 },        // combined %, split CGST+SGST below
  CGST: { type: Number, default: 0 },
  SGST: { type: Number, default: 0 },
  GrandTotal: { type: Number, required: true },

  Date: { type: String, required: true },
  Notes: { type: String, trim: true, default: "" }
});

app.get("/invoices", requireViewFinancials, async (req, res) => {
  try {
    const all = await invoice.find({}).sort({ Date: -1 });
    res.status(200).json(all);
  } catch (error) {
    res.status(500).json({ message: "Error fetching invoices", error: error.message });
  }
});

app.post("/invoices", requireAdmin, async (req, res) => {
  try {
    const { OrderId, Subtotal, GSTEnabled, GSTRate, Date: invDate, Notes, Description } = req.body;

    const order = await orders.findById(OrderId);
    if (!order) return res.status(404).json({ message: "Order not found" });

    const sub = Number(Subtotal);
    if (!Number.isFinite(sub) || sub < 0) return res.status(400).json({ message: "Enter a valid subtotal" });

    const gstOn = !!GSTEnabled;
    let rate = Number(GSTRate);
    if (!Number.isFinite(rate) || rate < 0) rate = 18;
    const gstTotal = gstOn ? sub * rate / 100 : 0;
    const cgst = gstTotal / 2, sgst = gstTotal / 2;
    const grandTotal = sub + gstTotal;

    let c = null;
    if (order.Client) c = await client.findById(order.Client);

    const prefix = "INV-";
    const latest = await invoice.findOne({ InvoiceID: { $regex: `^${prefix}` } }).sort({ InvoiceID: -1 });
    let num = 1;
    if (latest) {
      const n = parseInt(latest.InvoiceID.slice(prefix.length), 10);
      if (!isNaN(n)) num = n + 1;
    }
    const InvoiceID = `${prefix}${String(num).padStart(4, "0")}`;

    const newInvoice = new invoice({
      InvoiceID,
      Order: order._id,
      Client: c ? c._id : null,
      ClientName: c ? c.name : "",
      ClientAddress: c ? c.Add : "",
      ClientPhone: c ? c.Phone : "",
      ClientGSTIN: (req.body.ClientGSTIN || "").trim(),
      OrderTitle: order.OrderName || order.OrderID,
      Description: (Description || "").trim() || order.ItemDetails || "",
      Subtotal: sub,
      GSTEnabled: gstOn,
      GSTRate: rate,
      CGST: cgst,
      SGST: sgst,
      GrandTotal: grandTotal,
      Date: invDate || new Date().toISOString().slice(0, 10),
      Notes: (Notes || "").trim()
    });
    await newInvoice.save();

    order.History.push({ event: "Invoice", detail: `Invoice ${InvoiceID} generated (${gstOn ? 'incl. GST' : 'no GST'})`, date: new Date().toISOString() });
    await order.save();
    logActivity(req, "invoice.generated", `Generated invoice ${InvoiceID} for order ${order.OrderID} (₹${grandTotal})`);

    res.status(201).json({ message: "Invoice generated", invoice: newInvoice });
  } catch (error) {
    res.status(500).json({ message: "Error generating invoice", error: error.message });
  }
});

app.delete("/invoices/:id", requireAdmin, async (req, res) => {
  try {
    const removed = await invoice.findByIdAndDelete(req.params.id);
    if (!removed) return res.status(404).json({ message: "Invoice not found" });
    res.status(200).json({ message: "Invoice deleted" });
  } catch (error) {
    res.status(500).json({ message: "Error deleting invoice", error: error.message });
  }
});

//..........................EMPLOYEES (admin only)......................
// Separate from Team (app login accounts) — an employee is a person on the
// floor who may or may not ever log into Order Desk. Attendance and salary
// are tracked here regardless of whether they have an account.
const employee = mongoose.model("Employee", {
  EmployeeID: { type: String, required: true, unique: true },
  name: { type: String, required: true, trim: true },
  Phone: { type: String, default: "", trim: true },
  Role: { type: String, default: "", trim: true }, // job title / designation, e.g. "Machine Operator"
  JoiningDate: { type: String, default: "" },
  SalaryType: { type: String, enum: ["Monthly", "Daily"], default: "Monthly" },
  SalaryAmount: { type: Number, default: 0 }, // monthly amount, or per-day rate if Daily
  Active: { type: Boolean, default: true }, // false = no longer working here, but history is kept
  Payments: [{ forMonth: String, amount: Number, mode: String, date: String }],
  Deleted: { type: Boolean, default: false },
  DeletedAt: { type: String, default: null }
});

// One attendance record per employee per day.
const attendance = mongoose.model("Attendance", {
  Employee: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", required: true },
  Date: { type: String, required: true }, // YYYY-MM-DD
  Status: { type: String, enum: ["Present", "Absent", "Half Day", "Leave"], default: "Present" }
});

app.get("/employees", requireAdmin, async (req, res) => {
  try {
    const list = await employee.find({ Deleted: { $ne: true } }).sort({ name: 1 });
    res.status(200).json(list);
  } catch (error) {
    res.status(500).json({ message: "Error fetching employees", error: error.message });
  }
});

app.get("/employees/deleted", requireAdmin, async (req, res) => {
  try {
    const list = await employee.find({ Deleted: true }).sort({ DeletedAt: -1 });
    res.status(200).json(list);
  } catch (error) {
    res.status(500).json({ message: "Error fetching deleted employees", error: error.message });
  }
});

app.post("/employees", requireAdmin, async (req, res) => {
  try {
    const { name, Phone, Role, JoiningDate, SalaryType, SalaryAmount } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ message: "Name is required" });
    }
    const amt = Number(SalaryAmount);
    if (!Number.isFinite(amt) || amt < 0) {
      return res.status(400).json({ message: "Enter a valid salary amount" });
    }

    const prefix = `EMP-${new Date().getFullYear()}-`;
    const latest = await employee.findOne({ EmployeeID: { $regex: `^${prefix}` } }).sort({ EmployeeID: -1 });
    let num = 1;
    if (latest) {
      const n = parseInt(latest.EmployeeID.slice(prefix.length), 10);
      if (!isNaN(n)) num = n + 1;
    }
    const EmployeeID = `${prefix}${String(num).padStart(4, "0")}`;

    const newEmployee = new employee({
      EmployeeID,
      name: name.trim(),
      Phone: (Phone || "").trim(),
      Role: (Role || "").trim(),
      JoiningDate: JoiningDate || "",
      SalaryType: SalaryType === "Daily" ? "Daily" : "Monthly",
      SalaryAmount: amt
    });
    await newEmployee.save();

    res.status(201).json({ message: "Employee added", employee: newEmployee });
  } catch (error) {
    res.status(500).json({ message: "Error adding employee", error: error.message });
  }
});

app.patch("/employees/:id", requireAdmin, async (req, res) => {
  try {
    const emp = await employee.findById(req.params.id);
    if (!emp) {
      return res.status(404).json({ message: "Employee not found" });
    }
    const { name, Phone, Role, JoiningDate, SalaryType, SalaryAmount, Active } = req.body;

    if (name !== undefined) {
      if (!name.trim()) return res.status(400).json({ message: "Name is required" });
      emp.name = name.trim();
    }
    if (Phone !== undefined) emp.Phone = Phone.trim();
    if (Role !== undefined) emp.Role = Role.trim();
    if (JoiningDate !== undefined) emp.JoiningDate = JoiningDate;
    if (SalaryType !== undefined) emp.SalaryType = SalaryType === "Daily" ? "Daily" : "Monthly";
    if (SalaryAmount !== undefined) {
      const amt = Number(SalaryAmount);
      if (!Number.isFinite(amt) || amt < 0) return res.status(400).json({ message: "Enter a valid salary amount" });
      emp.SalaryAmount = amt;
    }
    if (Active !== undefined) emp.Active = !!Active;

    await emp.save();
    res.status(200).json({ message: "Employee updated", employee: emp });
  } catch (error) {
    res.status(500).json({ message: "Error updating employee", error: error.message });
  }
});

app.delete("/employees/:id", requireAdmin, async (req, res) => {
  try {
    const emp = await employee.findById(req.params.id);
    if (!emp) {
      return res.status(404).json({ message: "Employee not found" });
    }
    emp.Deleted = true;
    emp.DeletedAt = new Date().toISOString();
    await emp.save();
    res.status(200).json({ message: "Employee deleted" });
  } catch (error) {
    res.status(500).json({ message: "Error deleting employee", error: error.message });
  }
});

app.post("/employees/:id/restore", requireAdmin, async (req, res) => {
  try {
    const emp = await employee.findById(req.params.id);
    if (!emp) {
      return res.status(404).json({ message: "Employee not found" });
    }
    emp.Deleted = false;
    emp.DeletedAt = null;
    await emp.save();
    res.status(200).json({ message: "Employee restored", employee: emp });
  } catch (error) {
    res.status(500).json({ message: "Error restoring employee", error: error.message });
  }
});

app.delete("/employees/:id/forever", requireAdmin, async (req, res) => {
  try {
    const removed = await employee.findByIdAndDelete(req.params.id);
    if (!removed) {
      return res.status(404).json({ message: "Employee not found" });
    }
    await attendance.deleteMany({ Employee: req.params.id });
    await shift.deleteMany({ Employee: req.params.id });
    res.status(200).json({ message: "Employee permanently deleted" });
  } catch (error) {
    res.status(500).json({ message: "Error deleting employee", error: error.message });
  }
});

// RECORD A SALARY PAYMENT
app.post("/employees/:id/salary", requireAdmin, async (req, res) => {
  try {
    const { forMonth, amount, mode, date } = req.body;
    const amt = Number(amount);
    if (!forMonth || !/^\d{4}-\d{2}$/.test(forMonth)) {
      return res.status(400).json({ message: "forMonth must be in YYYY-MM format" });
    }
    if (!Number.isFinite(amt) || amt <= 0) {
      return res.status(400).json({ message: "Enter a valid amount" });
    }
    const emp = await employee.findById(req.params.id);
    if (!emp) {
      return res.status(404).json({ message: "Employee not found" });
    }
    emp.Payments.push({ forMonth, amount: amt, mode: mode || "Cash", date: date || new Date().toISOString().slice(0, 10) });
    await emp.save();
    res.status(201).json({ message: "Payment recorded", employee: emp });
  } catch (error) {
    res.status(500).json({ message: "Error recording payment", error: error.message });
  }
});

// MARK/UPDATE ATTENDANCE FOR ONE EMPLOYEE ON ONE DAY (upsert)
app.post("/attendance", requireAdmin, async (req, res) => {
  try {
    const { Employee, Date: dateStr, Status } = req.body;
    if (!Employee || !mongoose.isValidObjectId(Employee)) {
      return res.status(400).json({ message: "A valid employee is required" });
    }
    if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      return res.status(400).json({ message: "Date must be in YYYY-MM-DD format" });
    }
    if (!["Present", "Absent", "Half Day", "Leave"].includes(Status)) {
      return res.status(400).json({ message: "Invalid attendance status" });
    }
    const rec = await attendance.findOneAndUpdate(
      { Employee, Date: dateStr },
      { Employee, Date: dateStr, Status },
      { new: true, upsert: true }
    );
    res.status(200).json({ message: "Attendance marked", record: rec });
  } catch (error) {
    res.status(500).json({ message: "Error marking attendance", error: error.message });
  }
});

// GET ATTENDANCE FOR A MONTH (all employees) — e.g. /attendance?month=2026-10
app.get("/attendance", requireAdmin, async (req, res) => {
  try {
    const month = req.query.month;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ message: "month query param must be YYYY-MM" });
    }
    const records = await attendance.find({ Date: { $regex: `^${month}` } });
    res.status(200).json(records);
  } catch (error) {
    res.status(500).json({ message: "Error fetching attendance", error: error.message });
  }
});

//..........................SHIFT SCHEDULING (admin only)...................
// Separate from Attendance (which only records Present/Absent/Half/Leave
// after the fact) — this is a forward-looking schedule: who's working
// which shift on which day. Shift *types* (Morning, Night, Off, etc.) are
// admin-customizable, same spirit as the per-order-type roadmap.
const shiftPreset = mongoose.model("ShiftPreset", new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  start: { type: String, default: "" }, // "HH:MM", blank for an all-day/off preset
  end: { type: String, default: "" },
  color: { type: String, default: "#5d6a63" },
  isOff: { type: Boolean, default: false } // marks a "day off" type preset
}));
const DEFAULT_SHIFT_PRESETS = [
  { name: "Morning", start: "09:00", end: "17:00", color: "#2f6f4f" },
  { name: "Evening", start: "14:00", end: "22:00", color: "#a86a1d" },
  { name: "Night", start: "22:00", end: "06:00", color: "#3b4b9c" },
  { name: "Off", start: "", end: "", color: "#8a938d", isOff: true }
];
async function ensureShiftPresets() {
  const count = await shiftPreset.countDocuments();
  if (count === 0) await shiftPreset.insertMany(DEFAULT_SHIFT_PRESETS);
}
ensureShiftPresets().catch(err => console.error("Could not seed shift presets:", err.message));

// One shift assignment per employee per day (upsert, same pattern as attendance).
const shift = mongoose.model("Shift", new mongoose.Schema({
  Employee: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", required: true },
  Date: { type: String, required: true }, // YYYY-MM-DD
  Preset: { type: mongoose.Schema.Types.ObjectId, ref: "ShiftPreset", default: null },
  Label: { type: String, default: "" },   // snapshot of the preset's name at assignment time
  Start: { type: String, default: "" },
  End: { type: String, default: "" }
}));

app.get("/shift-presets", async (req, res) => {
  try {
    const all = await shiftPreset.find({}).sort({ isOff: 1, start: 1 });
    res.status(200).json(all);
  } catch (error) {
    res.status(500).json({ message: "Error fetching shift types", error: error.message });
  }
});

app.post("/shift-presets", requireAdmin, async (req, res) => {
  try {
    const { name, start, end, color, isOff } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ message: "A name is required" });
    const p = new shiftPreset({ name: name.trim(), start: start || "", end: end || "", color: color || "#5d6a63", isOff: !!isOff });
    await p.save();
    logActivity(req, "shift.preset_created", `Added shift type "${p.name}"`);
    res.status(201).json({ message: "Shift type added", preset: p });
  } catch (error) {
    res.status(500).json({ message: "Error adding shift type", error: error.message });
  }
});

app.patch("/shift-presets/:id", requireAdmin, async (req, res) => {
  try {
    const p = await shiftPreset.findById(req.params.id);
    if (!p) return res.status(404).json({ message: "Shift type not found" });
    const { name, start, end, color, isOff } = req.body;
    if (name !== undefined) {
      if (!name.trim()) return res.status(400).json({ message: "A name is required" });
      p.name = name.trim();
    }
    if (start !== undefined) p.start = start;
    if (end !== undefined) p.end = end;
    if (color !== undefined && color) p.color = color;
    if (isOff !== undefined) p.isOff = !!isOff;
    await p.save();
    res.status(200).json({ message: "Shift type updated", preset: p });
  } catch (error) {
    res.status(500).json({ message: "Error updating shift type", error: error.message });
  }
});

app.delete("/shift-presets/:id", requireAdmin, async (req, res) => {
  try {
    const removed = await shiftPreset.findByIdAndDelete(req.params.id);
    if (!removed) return res.status(404).json({ message: "Shift type not found" });
    await shift.deleteMany({ Preset: removed._id });
    logActivity(req, "shift.preset_deleted", `Deleted shift type "${removed.name}"`);
    res.status(200).json({ message: "Shift type deleted — any assignments using it were cleared" });
  } catch (error) {
    res.status(500).json({ message: "Error deleting shift type", error: error.message });
  }
});

// GET THE SCHEDULE FOR A MONTH (all employees) — e.g. /shifts?month=2026-10
app.get("/shifts", requireAdmin, async (req, res) => {
  try {
    const month = req.query.month;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ message: "month query param must be YYYY-MM" });
    }
    const records = await shift.find({ Date: { $regex: `^${month}` } });
    res.status(200).json(records);
  } catch (error) {
    res.status(500).json({ message: "Error fetching shifts", error: error.message });
  }
});

// ASSIGN (OR CLEAR) ONE EMPLOYEE'S SHIFT ON ONE DAY — upsert, same shape as attendance
app.post("/shifts", requireAdmin, async (req, res) => {
  try {
    const { Employee, Date: dateStr, PresetId } = req.body;
    if (!Employee || !mongoose.isValidObjectId(Employee)) {
      return res.status(400).json({ message: "A valid employee is required" });
    }
    if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      return res.status(400).json({ message: "Date must be in YYYY-MM-DD format" });
    }
    if (!PresetId) {
      // No preset = clear whatever was assigned that day.
      await shift.deleteOne({ Employee, Date: dateStr });
      return res.status(200).json({ message: "Shift cleared", record: null });
    }
    const preset = await shiftPreset.findById(PresetId);
    if (!preset) return res.status(400).json({ message: "That shift type could not be found" });

    const rec = await shift.findOneAndUpdate(
      { Employee, Date: dateStr },
      { Employee, Date: dateStr, Preset: preset._id, Label: preset.name, Start: preset.start, End: preset.end },
      { new: true, upsert: true }
    );
    res.status(200).json({ message: "Shift assigned", record: rec });
  } catch (error) {
    res.status(500).json({ message: "Error assigning shift", error: error.message });
  }
});

// Salary math lives here, in one place, so the list view, the attendance
// view, and the payment form all agree with each other.
//
// Policy (per the user's "per day deduction" request):
//   - Monthly salary: per-day rate = SalaryAmount / calendar days in that
//     month. Each Absent day deducts one full per-day rate; each Half Day
//     deducts half. Leave is treated as paid (no deduction) — it's kept as
//     its own status separate from Absent specifically so approved leave
//     doesn't cost the employee. If that's not the intended policy, this
//     is the one place to change it.
//   - Daily wage: there's no fixed monthly gross to deduct from — pay is
//     simply (days present × rate) + (half days × rate / 2).
function daysInMonth(ym) {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m, 0).getDate();
}
async function salarySummaryFor(emp, ym) {
  const days = daysInMonth(ym);
  const perDay = emp.SalaryType === "Daily" ? emp.SalaryAmount : emp.SalaryAmount / days;
  const recs = await attendance.find({ Employee: emp._id, Date: { $regex: `^${ym}` } });
  const count = s => recs.filter(r => r.Status === s).length;
  const presentDays = count("Present"), absentDays = count("Absent"), halfDays = count("Half Day"), leaveDays = count("Leave");
  const paid = (emp.Payments || []).filter(p => p.forMonth === ym).reduce((t, p) => t + (Number(p.amount) || 0), 0);

  let grossSalary, deduction, netSalary;
  if (emp.SalaryType === "Daily") {
    grossSalary = null;
    deduction = null;
    netSalary = perDay * presentDays + perDay * 0.5 * halfDays;
  } else {
    grossSalary = emp.SalaryAmount;
    deduction = perDay * absentDays + perDay * 0.5 * halfDays;
    netSalary = Math.max(grossSalary - deduction, 0);
  }

  return {
    EmployeeId: String(emp._id),
    forMonth: ym,
    daysInMonth: days,
    perDay,
    presentDays, absentDays, halfDays, leaveDays,
    grossSalary, deduction, netSalary,
    paid,
    due: netSalary - paid
  };
}

// SALARY SUMMARY FOR EVERY EMPLOYEE, FOR ONE MONTH
app.get("/employees/summary", requireAdmin, async (req, res) => {
  try {
    const month = req.query.month;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ message: "month query param must be YYYY-MM" });
    }
    const emps = await employee.find({ Deleted: { $ne: true } }).sort({ name: 1 });
    const summaries = await Promise.all(emps.map(e => salarySummaryFor(e, month)));
    res.status(200).json(summaries);
  } catch (error) {
    res.status(500).json({ message: "Error computing salary summary", error: error.message });
  }
});

// SALARY SUMMARY FOR ONE EMPLOYEE, FOR ONE MONTH
app.get("/employees/:id/summary", requireAdmin, async (req, res) => {
  try {
    const month = req.query.month;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ message: "month query param must be YYYY-MM" });
    }
    const emp = await employee.findById(req.params.id);
    if (!emp) {
      return res.status(404).json({ message: "Employee not found" });
    }
    res.status(200).json(await salarySummaryFor(emp, month));
  } catch (error) {
    res.status(500).json({ message: "Error computing salary summary", error: error.message });
  }
});

//..........................ROLES (admin only)...........................
// LIST ALL ROLES — anyone logged in can see them (needed to show colored
// role badges), but only an admin-or-above can create/edit/delete them.
app.get("/roles", async (req, res) => {
  try {
    const all = await teamRole.find({}).sort({ rank: -1 });
    res.status(200).json(all);
  } catch (error) {
    res.status(500).json({ message: "Error fetching roles", error: error.message });
  }
});

// CREATE A NEW ROLE
app.post("/roles", requireAdmin, async (req, res) => {
  try {
    const { name, color, rank, permissions } = req.body;
    const trimmedName = (name || "").trim();
    if (!trimmedName) return res.status(400).json({ message: "Role name is required" });
    if (["owner", "admin", "worker"].includes(trimmedName.toLowerCase())) {
      return res.status(400).json({ message: "That name is reserved for a built-in role" });
    }
    if (await teamRole.findOne({ name: new RegExp(`^${trimmedName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") })) {
      return res.status(409).json({ message: "A role with that name already exists" });
    }
    const rankNum = Number(rank);
    if (!Number.isFinite(rankNum) || rankNum < 1 || rankNum >= RANK.OWNER) {
      return res.status(400).json({ message: "Rank must be a number between 1 and 999" });
    }
    if (!canManageRank(req, rankNum)) {
      return res.status(403).json({ message: "You can't create a role with authority equal to or above your own" });
    }

    const newRole = new teamRole({ name: trimmedName, color: color || randomRoleColor(), rank: rankNum, permissions: sanitizePerms(permissions), isSystem: false });
    await newRole.save();
    logActivity(req, "role.created", `Created role "${trimmedName}" (rank ${rankNum})`);
    res.status(201).json({ message: "Role created", role: newRole });
  } catch (error) {
    res.status(500).json({ message: "Error creating role", error: error.message });
  }
});

// EDIT A ROLE — name, color, rank (its authority/position) and permissions
app.patch("/roles/:id", requireAdmin, async (req, res) => {
  try {
    const r = await teamRole.findById(req.params.id);
    if (!r) return res.status(404).json({ message: "Role not found" });
    if (r.isSystem) return res.status(400).json({ message: "Owner, Admin and Worker are built in and can't be edited" });
    if (!canManageRank(req, r.rank)) return res.status(403).json({ message: "You don't have authority over this role" });

    const { name, color, rank, permissions } = req.body;
    if (name !== undefined) {
      const trimmedName = name.trim();
      if (!trimmedName) return res.status(400).json({ message: "Role name is required" });
      if (["owner", "admin", "worker"].includes(trimmedName.toLowerCase())) {
        return res.status(400).json({ message: "That name is reserved for a built-in role" });
      }
      const dup = await teamRole.findOne({ _id: { $ne: r._id }, name: new RegExp(`^${trimmedName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") });
      if (dup) return res.status(409).json({ message: "A role with that name already exists" });
      r.name = trimmedName;
    }
    if (color !== undefined && color) r.color = color;
    if (rank !== undefined) {
      const rankNum = Number(rank);
      if (!Number.isFinite(rankNum) || rankNum < 1 || rankNum >= RANK.OWNER) {
        return res.status(400).json({ message: "Rank must be a number between 1 and 999" });
      }
      if (!canManageRank(req, rankNum)) {
        return res.status(403).json({ message: "You can't raise a role's authority to or above your own" });
      }
      r.rank = rankNum;
    }
    if (permissions !== undefined) r.permissions = sanitizePerms(permissions);

    await r.save();
    logActivity(req, "role.edited", `Edited role "${r.name}"`);
    res.status(200).json({ message: "Role updated", role: r });
  } catch (error) {
    res.status(500).json({ message: "Error updating role", error: error.message });
  }
});

// DELETE A ROLE — members holding it move to Worker
app.delete("/roles/:id", requireAdmin, async (req, res) => {
  try {
    const r = await teamRole.findById(req.params.id);
    