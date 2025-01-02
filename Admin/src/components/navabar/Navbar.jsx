import React from 'react'
import './navbar.css'
import navlogo from '../../assets/logo.jpg'

const Navbar = () => {
  return (
    <div className='navbar'>
        <img className='logo' src={navlogo} alt="" />
        <p>O.N ENGINEERING WORKS</p>
    </div>
  )
}

export default Navbar