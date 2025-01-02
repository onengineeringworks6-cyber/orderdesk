import React from 'react'
import './sidebar.css'
import { Link } from 'react-router-dom'

const Sidebar = () => {
  return (
    <div className='sidebar'>
        <Link to={'/addproduct'} style={{textDecoration:"none", color:"white"}}>
            <p className='addproduct'>Add Product</p>
        </Link>
        <Link to={'/removeproduct'} style={{textDecoration:"none", color:"white"}}>    
            <p className='removeproduct'>Remove Product</p>
        </Link>
        <Link to={'/listproduct'} style={{textDecoration:"none", color:"white"}}>
            <p className='listproduct'>List Product</p>
        </Link>
        
    </div>
  )
}

export default Sidebar