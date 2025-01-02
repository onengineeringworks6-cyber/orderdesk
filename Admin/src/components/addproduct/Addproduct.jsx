import React from 'react'
import upload_area from '../../assets/upload_area.svg'
import './addproduct.css'
import { useState } from 'react'

const addproduct = () => {
  const [image, setImage] = useState(false)
  const [productDetails, setProductDetails] = useState({
    name: '',
    description: '',
    category: 'Cutter',
    image: '',
  })

  const changeHandler = (e)=>{
    setProductDetails({
      ...productDetails,
      [e.target.name]:e.target.value
      
    })
  }

  const Add_Product = async () => {
    console.log(productDetails)
    let responseData
    let product = productDetails

    let formData = new FormData()
    formData.append('product', image)

    await fetch('http://localhost:4000/upload',{
      method:'POST',
      headers:{
        Accept:'application/json'
      },
      body:formData,
    }).then((resp)=>resp.json()).then((data)=>{responseData=data})
    if (responseData.success) {
      product.image = responseData.image_url
      console.log(product)
      await fetch('http://localhost:4000/addproduct',{
        method:'POST',
        headers:{
          'Content-Type':'application/json',
          Accept:'application/json'
        },
        body:JSON.stringify(product)
      }).then((resp)=>resp.json()).then((data)=>{
        data.success ? alert('Product Added Successfully') : alert('Product not Added')
      })
      
    }
  }
  

  const imageHandler = (e) => {
    setImage(e.target.files[0])
  }
  return (
    <div className='add-product'>
        <div className="add-product-itemfeild">
            <p>Product Title</p>
            <input value={productDetails.name} onChange={changeHandler} type="text" name='name' placeholder='Enter product title'/>
        </div>
        <div className="add-product-itemfeild">
            <p>Product Despcription</p>
            <input value={productDetails.description} onChange={changeHandler} type="text" name='description' placeholder='Enter product description'/>
        </div>
        <div className="add-product-itemfeild">
            <select value={productDetails.category} onChange={changeHandler} className='add-product-selctor' name="category">
              <option value="Cutter">Cutter</option>
              <option value="Extruder">Extruder</option>
              <option value="Scrapper">Scrapper</option>
              <option value="Washer">Washer</option>
              <option value="Agro">Agro</option>
              <option value="Mixture">Mixture</option>
              <option value="Baram">Baram</option>
              <option value="Labour Job">Labour Job</option>
            </select>
        </div>
        <div className="add-product-itemfeild">
          <label htmlFor="file-input">
            <img src={image?URL.createObjectURL(image) : upload_area} alt="" />
          </label>
          <input  onChange={imageHandler}  type="file" name='image' id='file-input' hidden />
        </div>
        <button onClick={()=>{Add_Product()}} className='add-product-btn'>Add</button>
    </div>
  )
}

export default addproduct