// =============== MODULES =============================
const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
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
  role: {
    type: String,
    enum: ["admin", "worker"],
    default: "admin"
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

// Require a valid login token on every route this runs before.
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ message: "Please log in" });
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    // Look the user up every time, so removing or demoting someone takes
    // effect immediately instead of when their 30-day token runs out.
    const user = await admin.findById(decoded.id, "username role");
    if (!user) {
      return res.status(401).json({ message: "This account no longer exists" });
    }
    req.user = { id: String(user._id), username: user.username, role: user.role || "admin" };
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

// Shape an order for the caller: admins get everything, workers get no money.
function forRole(req, orderDoc) {
  return req.user.role === "admin" ? orderDoc : stripFinancials(orderDoc);
}

// Removes money-related fields from an order before it's sent to a
// non-admin user.
function stripFinancials(orderDoc) {
  const o = orderDoc.toObject ? orderDoc.toObject() : orderDoc;
  const { TotalValue, Advance, RemainingPayment, EstimatedCost, PurchaseCost, AdvanceHistory, History, Expenses, ...safe } = o;
  return safe;
}

// USER SIGNUP — bootstrap-only: works once, to create your first (and only)
// admin account, then locks itself automatically once any admin exists.
// This closes the previously-open public signup endpoint without needing
// any separate secret or manual step.
app.post('/signup', async (req, res) => {
  try {
    const existingCount = await admin.countDocuments();
    if (existingCount > 0) {
      return res.status(403).json({ message: "Signup is closed — an admin account already exists." });
    }

    const { username, password } = req.body;
    if (!username || !password || password.length < 6) {
      return res.status(400).json({ message: "Username and a password of at least 6 characters are required" });
    }

    const hashed = await bcrypt.hash(password, 10);
    const newAdmin = new admin({ username, password: hashed });

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

    res.status(200).json({
      message: "Login successful",
      token,
      id: existingAdmin._id.toString(),
      username: existingAdmin.username,
      role
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

// One shared 6-step roadmap for every order type (v1 change — used to vary
// by type, now unified at the user's request). Keep in sync with STAGES
// on the frontend.
const STAGES = ["Raw material", "Processing", "Completion of order", "To be delivered", "Delivered", "Money received"];

// Moves an order to its closed-out state: Closed if fully paid, otherwise
// "Payment Due" so unpaid work never silently disappears into Closed.
// markPaidIfDue only applies when explicitly requested (the "mark as paid"
// checkbox) — reaching the last stage on its own never fabricates a payment.
function applyClose(order, markPaidIfDue) {
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
  order.Stage = STAGES.length;
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
      AssignedTo
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

    const now = new Date().toISOString();
    const newOrder = new orders({
      OrderID,
      OrderName: (OrderName || "").trim() || OrderID,
      OrderType: type,
      Client,
      Product: Product && Product.trim() ? Product : null,
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

    res.status(200).json(
      req.user.role === "admin" ? allorders : allorders.map(stripFinancials)
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

    const { OrderName, ReceivingDate, DeliveryDate, TotalValue, EstimatedCost, PurchaseCost, ItemDetails, Product } = req.body;
    const changes = [];

    if (Product !== undefined) {
      order.Product = Product && Product.trim() ? Product : null;
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
      detail = applyClose(order, markPaid && req.user.role === "admin");
    } else if (Status === "Payment Due") {
      order.Status = "Payment Due";
      detail = "Marked Payment Due";
    } else {
      order.Status = "Active";
      detail = "Reopened";
    }
    order.History.push({ event: "Status", detail, date: new Date().toISOString() });

    await order.save();

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

// UPDATE ORDER STAGE — the number of valid steps depends on OrderType
// (see STAGES above).
app.patch('/orders/:id/stage', async (req, res) => {
  try {
    const order = await orders.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    const step = Number(req.body.Stage);
    const maxStage = STAGES.length;

    if (!Number.isInteger(step) || step < 1 || step > maxStage) {
      return res.status(400).json({ message: `Stage must be between 1 and ${maxStage}` });
    }

    order.Stage = step;
    let detail = `Moved to step ${step} of ${maxStage}: ${STAGES[step - 1]}`;
    // Reaching the last stage ("Money received") closes the order out by
    // default — Closed if paid, Payment Due if not. Never fabricates a
    // payment on its own; that only happens via the explicit checkbox.
    if (step === maxStage && order.Status !== "Closed") {
      detail += ` · ${applyClose(order, false)}`;
    }
    order.History.push({ event: "Stage", detail, date: new Date().toISOString() });
    await order.save();

    res.status(200).json({ message: "Stage updated", order: forRole(req, order) });
  } catch (error) {
    res.status(500).json({ message: "Error updating stage", error: error.message });
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
  }

});

// ADDING NEW PRODUCT
app.post("/addproduct", requireAdmin, async (req, res) => {

  try {

    const { name, desc, category } = req.body;

    // Required field validation
    if (!name || !desc || !category) {
      return res.status(400).json({
        message: "Name, description and category are required"
      });
    }

    // Generate Product ID
    const productCount = await product.countDocuments();

    const ProductID =
      `PROD-${String(productCount + 1).padStart(4, "0")}`;

    const newProduct = new product({

      ProductID,
      name,
      desc,
      category

    });

    await newProduct.save();

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

//..........................QUOTATIONS (admin only).........................
const quote = mongoose.model("Quote", {
  QuoteID: { type: String, required: true, unique: true },
  Client: { type: mongoose.Schema.Types.ObjectId, ref: "Client", default: null },
  ProspectName: { type: String, trim: true, default: "" },
  ProspectPhone: { type: String, trim: true, default: "" },
  Description: { type: String, trim: true, default: "" },
  Amount: { type: Number, required: true },
  ValidUntil: { type: String, default: "" },
  Status: { type: String, enum: ["Draft", "Sent", "Accepted", "Rejected", "Converted"], default: "Draft" },
  ConvertedOrderId: { type: mongoose.Schema.Types.ObjectId, ref: "Orders", default: null },
  CreatedAt: { type: String, default: () => new Date().toISOString() }
});

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
    const { Client, ProspectName, ProspectPhone, Description, Amount, ValidUntil } = req.body;
    const amt = Number(Amount);

    if (!Number.isFinite(amt) || amt <= 0) {
      return res.status(400).json({ message: "Enter a valid amount" });
    }
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

    const newQuote = new quote({
      QuoteID,
      Client: Client && Client.trim() ? Client : null,
      ProspectName: (ProspectName || "").trim(),
      ProspectPhone: (ProspectPhone || "").trim(),
      Description: (Description || "").trim(),
      Amount: amt,
      ValidUntil: ValidUntil || ""
    });
    await newQuote.save();

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

    const { Status, Description, Amount, ValidUntil, ProspectName, ProspectPhone } = req.body;

    if (Status !== undefined) {
      if (!["Draft", "Sent", "Accepted", "Rejected"].includes(Status)) {
        return res.status(400).json({ message: "Invalid status" });
      }
      q.Status = Status;
    }
    if (Description !== undefined) q.Description = Description.trim();
    if (Amount !== undefined) {
      const amt = Number(Amount);
      if (!Number.isFinite(amt) || amt <= 0) {
        return res.status(400).json({ message: "Enter a valid amount" });
      }
      q.Amount = amt;
    }
    if (ValidUntil !== undefined) q.ValidUntil = ValidUntil;
    if (ProspectName !== undefined) q.ProspectName = ProspectName.trim();
    if (ProspectPhone !== undefined) q.ProspectPhone = ProspectPhone.trim();

    await q.save();
    res.status(200).json({ message: "Quotation updated", quote: q });
  } catch (error) {
    res.status(500).json({ message: "Error updating quotation", error: error.message });
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

    const newOrder = new orders({
      OrderID,
      OrderName: q.Description ? q.Description.slice(0, 60) : OrderID,
      OrderType: "New Order",
      Client: clientId,
      ReceivingDate: today,
      DeliveryDate: today,
      Advance: 0,
      AdvanceMode: "Cash",
      AdvanceDate: today,
      TotalValue: q.Amount,
      ItemDetails: q.Description,
      RemainingPayment: q.Amount,
      AdvanceHistory: [],
      History: [{ event: "Created", detail: `Order created from quotation ${q.QuoteID}`, date: now }]
    });
    await newOrder.save();

    q.Status = "Converted";
    q.ConvertedOrderId = newOrder._id;
    await q.save();

    res.status(201).json({ message: "Quotation converted to order", order: newOrder, quote: q });
  } catch (error) {
    res.status(500).json({ message: "Error converting quotation", error: error.message });
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

//..........................TEAM (admin only).........................
// LIST TEAM MEMBERS
app.get("/team", requireAdmin, async (req, res) => {
  try {
    const team = await admin.find({}, "username role");
    res.status(200).json(team);
  } catch (error) {
    res.status(500).json({ message: "Error fetching team", error: error.message });
  }
});

// ADD A TEAM MEMBER
app.post("/team", requireAdmin, async (req, res) => {
  try {
    const { username, password, role } = req.body;

    if (!username || !username.trim() || !password || password.length < 6) {
      return res.status(400).json({ message: "Username and a password of at least 6 characters are required" });
    }

    const existing = await admin.findOne({ username: username.trim() });
    if (existing) {
      return res.status(409).json({ message: "That username is already taken" });
    }

    const hashed = await bcrypt.hash(password, 10);
    const newMember = new admin({
      username: username.trim(),
      password: hashed,
      role: role === "admin" ? "admin" : "worker"
    });
    await newMember.save();

    res.status(201).json({
      message: "Team member added",
      member: { _id: newMember._id, username: newMember.username, role: newMember.role }
    });
  } catch (error) {
    res.status(500).json({ message: "Error adding team member", error: error.message });
  }
});

// REMOVE A TEAM MEMBER
app.delete("/team/:id", requireAdmin, async (req, res) => {
  try {
    if (req.params.id === req.user.id) {
      return res.status(400).json({ message: "You can't remove your own account while logged in as it" });
    }
    const removed = await admin.findByIdAndDelete(req.params.id);
    if (!removed) {
      return res.status(404).json({ message: "Team member not found" });
    }
    res.status(200).json({ message: "Team member removed" });
  } catch (error) {
    res.status(500).json({ message: "Error removing team member", error: error.message });
  }
});

app.get('/', (req, res) => {
  res.send('Hello World!');
});

module.exports = app;

if (require.main === module) {
  app.listen(port, () => console.log(`Listening on port ${port}`));
}