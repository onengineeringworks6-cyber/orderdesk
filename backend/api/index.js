// =============== MODULES =============================
const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
// =====================================================

// ================ BASIC APP ==========================
const app = express();
const port = 3000;
app.use(express.json());
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
  }
});

// USER SIGNUP
app.post('/signup', async (req, res) => {
  try {
    const newAdmin = new admin({
      username: req.body.username,
      password: req.body.password
    });

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

    if (existingAdmin.password !== password) {
      return res.status(401).json({
        message: "Invalid username or password"
      });
    }

    res.status(200).json({
      message: "Login successful"
    });

  } catch (error) {
    res.status(500).json({
      message: "Server error",
      error: error.message
    });
  }
});


// ...............................ORDERS...............................
// ORDER MODEL
const orders = mongoose.model("Orders", {
  OrderID: {
    type: String,
    required: true,
    unique: true
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

  RemainingPayment: {
    type: Number,
    required: true
  },

  Status: {
    type: String,
    enum: ["Active", "Completed"],
    default: "Active"
  },

  // Production/delivery roadmap step: 1 Buying raw material,
  // 2 Processing raw material, 3 Completion of order, 4 Delivery of order
  Stage: {
    type: Number,
    enum: [1, 2, 3, 4],
    default: 1
  },

  // History of every advance payment made against this order,
  // including the initial one taken when the order was created.
  AdvanceHistory: [{
    amount: Number,
    mode: String,
    date: String
  }]
});

app.post("/neworder", async (req, res) => {
  try {

    const {
      Client,
      ReceivingDate,
      DeliveryDate,
      Advance,
      AdvanceMode,
      AdvanceDate,
      TotalValue
    } = req.body;

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

    const newOrder = new orders({
      OrderID,
      Client,
      ReceivingDate,
      DeliveryDate,
      Advance,
      AdvanceMode,
      AdvanceDate,
      TotalValue,
      RemainingPayment: TotalValue - Advance,
      AdvanceHistory: Advance > 0 ? [{ amount: Advance, mode: AdvanceMode, date: AdvanceDate }] : []
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

// GETTING ALL THE ORDERS
app.get('/orders', async (req, res) => {
  try {
    const allorders = await orders.find({});

    res.status(200).json(allorders);

  } catch (error) {
    res.status(500).json({
      message: "Error fetching orders",
      error: error.message
    });
  }
});

// EDIT AN ORDER
app.patch('/orders/:id', async (req, res) => {
  try {
    const order = await orders.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    const { ReceivingDate, DeliveryDate, TotalValue } = req.body;

    if (ReceivingDate !== undefined) order.ReceivingDate = ReceivingDate;
    if (DeliveryDate !== undefined) order.DeliveryDate = DeliveryDate;

    if (TotalValue !== undefined) {
      const newTotal = Number(TotalValue);
      if (newTotal < order.Advance) {
        return res.status(400).json({
          message: "Total value cannot be less than the advance already received"
        });
      }
      order.TotalValue = newTotal;
      order.RemainingPayment = newTotal - order.Advance;
    }

    await order.save();

    res.status(200).json({ message: "Order updated", order });
  } catch (error) {
    res.status(500).json({ message: "Error updating order", error: error.message });
  }
});

// DELETE AN ORDER
app.delete('/orders/:id', async (req, res) => {
  try {
    const order = await orders.findByIdAndDelete(req.params.id);
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }
    res.status(200).json({ message: "Order deleted" });
  } catch (error) {
    res.status(500).json({ message: "Error deleting order", error: error.message });
  }
});

// ADD AN ADVANCE PAYMENT TO AN EXISTING ORDER
app.post('/orders/:id/advance', async (req, res) => {
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

    if (!["Active", "Completed"].includes(Status)) {
      return res.status(400).json({ message: "Status must be Active or Completed" });
    }

    const update = { Status };
    if (Status === "Completed" && markPaid) update.RemainingPayment = 0;

    const order = await orders.findByIdAndUpdate(req.params.id, update, { new: true });

    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    res.status(200).json({ message: "Order updated", order });
  } catch (error) {
    res.status(500).json({ message: "Error updating order", error: error.message });
  }
});

// UPDATE ORDER STAGE (roadmap: 1 Buying raw material, 2 Processing raw material,
// 3 Completion of order, 4 Delivery of order)
app.patch('/orders/:id/stage', async (req, res) => {
  try {
    const step = Number(req.body.Stage);

    if (![1, 2, 3, 4].includes(step)) {
      return res.status(400).json({ message: "Stage must be 1, 2, 3, or 4" });
    }

    const order = await orders.findByIdAndUpdate(req.params.id, { Stage: step }, { new: true });

    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    res.status(200).json({ message: "Stage updated", order });
  } catch (error) {
    res.status(500).json({ message: "Error updating stage", error: error.message });
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

  Add: {
    type: String,
    required: true,
    trim: true
  },

  Phone: {
    type: String,
    required: true,
    trim: true
  }
});

// ADDING NEW CLIENT
app.post("/newclient", async (req, res) => {
  try {

    const { name, Add, Phone } = req.body;

    // Required fields
    if (!name || !Add || !Phone) {
      return res.status(400).json({
        message: "Name, address and phone are required"
      });
    }

    // Basic phone validation
    if (!/^\d{10}$/.test(Phone)) {
      return res.status(400).json({
        message: "Phone number must be 10 digits"
      });
    }

    // Check duplicate phone
    const existingClient = await client.findOne({ Phone });

    if (existingClient) {
      return res.status(409).json({
        message: "Client with this phone number already exists"
      });
    }

    const newClient = new client({
      name,
      Add,
      Phone
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
app.patch("/clients/:id", async (req, res) => {
  try {
    const { name, Add, Phone } = req.body;

    if (!name || !Add || !Phone) {
      return res.status(400).json({ message: "Name, address and phone are required" });
    }
    if (!/^\d{10}$/.test(Phone)) {
      return res.status(400).json({ message: "Phone number must be 10 digits" });
    }

    const duplicate = await client.findOne({ Phone, _id: { $ne: req.params.id } });
    if (duplicate) {
      return res.status(409).json({ message: "Another client already uses this phone number" });
    }

    const updated = await client.findByIdAndUpdate(
      req.params.id,
      { name, Add, Phone },
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
app.delete("/clients/:id", async (req, res) => {
  try {
    const existingOrders = await orders.countDocuments({ Client: req.params.id });
    if (existingOrders > 0) {
      return res.status(409).json({
        message: "This client still has orders on record. Delete those orders first."
      });
    }

    const deleted = await client.findByIdAndDelete(req.params.id);
    if (!deleted) {
      return res.status(404).json({ message: "Client not found" });
    }

    res.status(200).json({ message: "Client deleted" });
  } catch (error) {
    res.status(500).json({ message: "Error deleting client", error: error.message });
  }
});

// GET ALL CLIENTS
app.get("/allclients", async (req, res) => {
  try {

    const allclients = await client.find({});

    const clients = await Promise.all(

      allclients.map(async (clientData) => {

        const clientOrders = await orders.find({
          Client: clientData._id
        });

        const activeOrders = clientOrders.filter(
          order => order.Status === "Active"
        );

        const balanceDue = clientOrders.reduce(
          (total, order) => total + order.RemainingPayment,
          0
        );

        return {

          _id: clientData._id,

          name: clientData.name,

          Add: clientData.Add,

          Phone: clientData.Phone,

          TotalOrders: clientOrders.length,

          ActiveOrders: activeOrders.length,

          BalanceDue: balanceDue,

          Orders: clientOrders.map(order => ({
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
          }))

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
app.post("/addproduct", async (req, res) => {

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

app.get('/', (req, res) => {
  res.send('Hello World!');
});

module.exports = app;

if (require.main === module) {
  app.listen(port, () => console.log(`Listening on port ${port}`));
}