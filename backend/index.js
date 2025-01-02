const port = 4000;
const jwt = require('jsonwebtoken');
const cors = require('cors');
const mongoose = require('mongoose');
const multer = require('multer');
const express = require('express');
const app = express();
const path = require('path');
const fs = require('fs');

app.use(express.json());
app.use(cors());

// connecting the database
mongoose.connect('mongodb+srv://onengineeringworks6:4eeLxPFm2LUq2Lrd@cluster0.n5jpr.mongodb.net/engineering');

// Home route
app.get('/', (req, res) => {
  res.send('Express app is running');
});

// Image storage engine
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, 'upload', 'images')); // Use path.join for cross-platform support
  },
  filename: (req, file, cb) => {
    cb(null, `${file.fieldname}_${Date.now()}${path.extname(file.originalname)}`);
  },
});
const upload = multer({ storage: storage });

// Serve images statically
app.use('/images', express.static('upload/images'));

// IMAGE UPLOADING API
app.post('/upload', upload.single('product'), (req, res) => {
  console.log('File:', req.file); // Log file details to verify
  if (req.file) {
    res.json({
      success: 1,
      image_url: `http://localhost:${port}/images/${req.file.filename}`,
    });
  } else {
    res.status(400).json({ success: 0, message: 'File upload failed' });
  }
});
// creatind dchema for the database
const Product = mongoose.model('Product', {
  id: {
    type: Number,
    required: true,
  },
  name: {
    type: String,
    required: true,
  },
  image: {
    type: String,
    required: true,
  },
  category: {
    type: String,
    required: true,
  },
  description: {
    type: String,
    required: true,
  },
});

// creating api for adding product
app.post('/addproduct', async (req, res) => {
  let products = await Product.find({})
  let id
  if (products.length>0) {
    let last_product_array = products.slice(-1)
    let last_product = last_product_array[0]
    id = last_product.id + 1
  }
  else {
    id = 1
  }
  const product = new Product({
    id: id,
    name: req.body.name,
    image: req.body.image,
    category: req.body.category,
    description: req.body.description,
  })
  console.log(product)
  await product.save()
  console.log('Product added successfully')
  res.json({ success: 1, message: 'Product added successfully', name:req.body.name })
})

// creartng api for deleting product
app.delete('/deleteproduct', async (req, res) => {
  await Product.findOneAndDelete({ id: req.body.id })
  console.log('Product deleted successfully')
  res.json({ success: 1, message: 'Product deleted successfully', name:req.body.name })
})

// creating api to get all products
app.get('/getproducts', async (req, res) => {
  let products = await Product.find({})
  res.json({ success: 1, products: products })
})

// schema for usermodel
const users = mongoose.model('User',{
  name:{
    type:String,
    required:true
  },
  email:{
    type:String,
    required:true
  },
  password:{
    type:String,
    required:true
  }
})

// creating api for signup
app.post('/signup', async (req,res) => {
  let check = await users.findOne({
    email:req.body.email
  })
  if (check) {
    res.json({
      success:false,
      message:'Email already exists'
    })
  }
  const user = new users({
    name:req.body.name,
    email:req.body.email,
    password:req.body.password
  })
  await user.save()
  const data = {
    user:{
      id:user.id
    }
  }
  const token = jwt.sign(data,'secretkey')
  res.json({
    success:true,
    message:'User registered successfully',
    token:token
  })
})

// crating api for login
app.post('/login', async (req,res) => {
  let user = await users.findOne({
    email:req.body.email
  })
  if (users) {
    const passComapre = req.body.password === user.password
    if (passComapre) {
      const data = {
        user:{id:user.id}
      }
      const token = jwt.sign(data,'secret_ecom')
      res.json({
        success:true,token
      })
    }
    else{
      res.json({
        success:false,
        password:'Password is incorrect'
      })}
  }
  else{
    res.json({
      success:false,
      message:'User not found'
  })}
}
)

// Start the server
app.listen(port, (error) => {
  if (!error) {
    console.log("Server running on port " + `http://localhost:${port}`);
  } else {
    console.error("Error starting the server:", error);
  }
});
