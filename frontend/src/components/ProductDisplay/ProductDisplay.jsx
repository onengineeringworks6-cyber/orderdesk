import React from 'react'
import './productdisplay.css'
import { Link } from 'react-router-dom';

const ProductDisplay = (props) => {
    const { product } = props
    if (!product) {
        return <div>Product not found!</div>;
    }
    return (
        <>
            <div className="productdisplay">
                <div className="left">
                    <img src={product.image} alt="" />
                </div>
                <div className="content">
                    <h1>{product.name}</h1>
                    <p>{product.description}</p>
                    <Link to='/contact'><button>Get Qoute</button></Link>
                </div>

            </div>
        </>
    )
}

export default ProductDisplay