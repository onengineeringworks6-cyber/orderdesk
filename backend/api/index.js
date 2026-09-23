// =============== MODULES =============================
const express = require('express');
const mongoose = require('mongoose')
const path = require('path')
// =====================================================

// ================ BASIC APP ==========================
const app = express();
const port = 3000;
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'static')));
// =====================================================

// DATABASE CONNECTION
mongoose.connect("mongodb+srv://onengineeringworks6:VAoDEw90cQoK36qT@cluster0.n5jpr.mongodb.net/?appName=Cluster0")

// USER MODEL
const admin = mongoose.model("Admin",{
    username:{
        type:String,
        required:true
    },
    password:{
        type:String,
        requiered:true
    }
})

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
// // ORDER MODEl
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
  }
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
    const orderCount = await orders.countDocuments();

    // Generate human-readable ID
    const OrderID = `ORD-${new Date().getFullYear()}-${String(orderCount + 1).padStart(4, "0")}`;

    const newOrder = new orders({
      OrderID,
      Client,
      ReceivingDate,
      DeliveryDate,
      Advance,
      AdvanceMode,
      AdvanceDate,
      TotalValue,
      RemainingPayment: TotalValue - Advance
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

// deploy check)