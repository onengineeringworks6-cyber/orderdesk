import React from 'react'
import './contact.css'
import contact from '../Assets/contact2.webp'

const Contact = () => {
  return (
    <div className='contact'>
      <h1>Contact</h1>
        <p>Tell us what you need and our professionals will contact you!</p>
      <div className="contact-content">
        <div className="input">
          <input type="text" placeholder='Name' />
          <input type="text" placeholder='Phone' />
          <div className="textarea">
          <textarea type="text" placeholder='Description' />
          </div>
        <div className="btn">
          <button>Submit</button>
        </div>
        </div>
        <div className="side-image">
          <img src={contact} alt="" />
        </div>
      </div>
    </div>
  )
}

export default Contact