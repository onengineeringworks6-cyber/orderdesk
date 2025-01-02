import React from 'react'
import './footer.css'
import logo from '../Assets/O.n. engineering works.jpg'
import facebook from '../Assets/facebook (1).png'
import instagram from '../Assets/instagram (1).png'
import youtube from '../Assets/youtube.png'

const Footer = () => {
  return (
    <div className='footer'>
      <div className="footer-right">
        <div className="footer-logo">
          <div className="logo">
            <img src={logo} alt="" /> 
            <h1>O.N Engineering Works</h1>
          </div>
          
          <div className="footer-nav">
            <ul>
              <li>Home</li>
              <li>Contact</li>
              <li>About</li>
              <li>Product</li>
            </ul>
          </div>

        </div>
      </div>
      <div className="footer-left">
        <div className="add">
          <p>Add : Sector-3, J-62, Bawana Industrial Area, Delhi-110039</p>
          <p>Phone : 8377089148</p>
        </div>
        <div className="social-icon">
          <img src={facebook} alt="" />
          <img src={instagram} alt="" />
          <img src={youtube} alt="" />
        </div>
      </div>
    </div>
  )
}

export default Footer