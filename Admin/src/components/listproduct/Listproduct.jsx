import React, { useEffect } from 'react'
import './listproduct.css'
import { useState } from 'react'
import cross_icon from '../../assets/cross_icon.png'

const Listproduct = () => {
    
    const [allproducts,setAllproducts] = useState([])

    const fetchInfo = async () => {
      await fetch('http://localhost:4000/getproducts')
      .then((res)=>res.json())
      .then((data)=>{setAllproducts(data.products || [])})
    }
    
    useEffect(() => {
      fetchInfo()
    }, [])

    const removeProduct = async (id) => {
      await fetch('http://localhost:4000/deleteproduct',{
        method:'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify({id:id})
      })
      await fetchInfo()
    }
    

  return (
    <div className='list-product'>
        <h1>All Products</h1>
        <div className="listproduct-format-main">
            <p>Product</p>
            <p>title </p>
            <p>Description</p>
            <p>Category</p>
            <p>Remove</p>
        </div>
        <div className="listproduct-allproduct">
            <hr />
            {allproducts.map((products,index)=>{
                return <>
                    <div key={index} className="listproduct-format-main listproduct-format">
                        <img className='listproduct-image' src={products.image} alt="" />
                        <p>{products.name}</p>
                        <p>{products.description}</p>
                        <p>{products.category}</p>
                        <img onClick={()=>{removeProduct(products.id)}} src={cross_icon} alt="" />
                    </div> 
                    <hr />
                </>
            })}
        </div>
    </div>
  )
}

export default Listproduct