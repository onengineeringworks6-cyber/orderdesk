import React from 'react'
import './itemdisplay.css'
import { Link } from 'react-router-dom'

const ItemDisplay = (props) => {
  return (
    <div className='item'>
        <Link to={`/product/${props.id}`}><img onClick={window.scrollTo(0,0)} src={props.image} alt="" /></Link>
        <div className="item-content">
          <p>{props.name}</p>
        <Link to={`/product/${props.id}`}><button>Get qoute</button></Link>
        </div>
        
    </div>
  )
}

export default ItemDisplay