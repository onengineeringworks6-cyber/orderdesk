import React from 'react'
import './CSS/product.css'
import cutter from '../components/Assets/Gujrat_cutter_without_pully.png'
import extrder from '../components/Assets/Extruder1.png'
import mixture from '../components/Assets/Mixture_25Kg.png'
import scrapper from '../components/Assets/SC_LongHarper.png'
import scrapper2 from '../components/Assets/Scrapper_16inch.png'
import { ShopContext } from '../Context/ShopContext'
import  ItemDisplay  from '../components/Itemdisplay/ItemDisplay'
import { useContext } from 'react'
import all_product from '../components/Assets/all_product'

const Products = (props) => {

  return (
    <div className="product-page">
      <div className="category-section">
        <div className="category-extruder category-common">
          <img src={extrder} alt="" />
          <div className="category-name">
            <p>Exturder Machine</p>
          </div>
        </div>
        <div className="category-scrapper category-common">
          <img src={scrapper} alt="" />
          <div className="category-name">
            <p>Scrapper</p>
          </div>
        </div>
        <div className="category-mixture category-common">
          <img src={mixture} alt="" />
          <div className="category-name">
            <p>Mixtures</p>
          </div>
        </div>
        <div className="category-wahser category-common">
          <img src={scrapper2} alt="" />
          <div className="category-name">
            <p>Washers</p>
          </div>
        </div>
        <div className="category-cutter category-common">
          <img src={cutter} alt="" />
          <div className="category-name">
            <p>Cutters</p>
          </div>
        </div>
      </div>
      <div className="product">
      </div>
      <div className="product-display">
        {all_product.map((item,i) => {
          return <ItemDisplay key={i} id={item.id} name={item.name} image={item.image}/>
        })}
      </div>
    </div>
  )
}

export default Products