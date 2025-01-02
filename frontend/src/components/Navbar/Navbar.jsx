import React, { useState } from 'react'
import './navbar.css'
import logo from '../Assets/O.n. engineering works.jpg'
import { Link } from 'react-router-dom'

const Navbar = () => {

    const [menu, setMenu] = useState('home')

    return (
        <div className='navbar'>
            <div className="right">
                <img src={logo} alt="" />
                <h1>O.N Engineering Works</h1>
            </div>
            <div className="nav-list">
                <ul>
                    <li onClick={() => { setMenu('home') }}><Link style={{ textDecoration: 'none', color:"white" }} to='/'>Home</Link>{menu === 'home' ? <hr /> : <></>}</li>
                    <li onClick={() => { setMenu('products') }}><Link style={{ textDecoration: 'none', color:"white" }} to='/products'>Products</Link>{menu === 'products' ? <hr /> : <></>}</li>
                    <li onClick={() => { setMenu('contact') }}><Link style={{ textDecoration: 'none', color:"white" }} to='/contact'>Contact</Link>{menu === 'contact' ? <hr /> : <></>}</li>
                    <li onClick={() => { setMenu('about') }}><Link style={{ textDecoration: 'none', color:"white" }} to='/about'>About</Link>{menu === 'about' ? <hr /> : <></>}</li>
                </ul>
            </div>
        </div>
    )
}

export default Navbar
