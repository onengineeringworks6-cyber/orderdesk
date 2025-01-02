import React from 'react'
import banner_image from '../components/Assets/isis-franca-hsPFuudRg5I-unsplash.jpg'
import './CSS/home.css'
import { Link } from 'react-router-dom'
import banner_product_image from '../components/Assets/Extruder1.png'
import scrapper from '../components/Assets/SC_LongHarper.png'
import extruder from '../components/Assets/Extruder1.png'
import mixture from '../components/Assets/Mixture_25Kg.png'
import cutter from '../components/Assets/GC_With_stand.png'
import Contact from '../components/contact/Contact'


const Home = () => {
  return (
    <div className='home'>
      <div className="banner">
        {/* <img src={banner_image} alt="" /> */}
      </div>
      <div className="banner-content">
        <p className='welcome-content'>Welcome to Our Machine Manufacturing Company</p>
        <h1>O.N ENGINEERING WORKS</h1>
        <p className='banner-description'>At our machine manufacturing company, we are dedicated to providing high-quality, durable</p>
        <Link to='/products'><button>Explore More</button></Link>
        <div className="banner_product_image">
          <img src={banner_product_image} alt="" />
        </div>
      </div>
      <div className="below-banner">
        <div className="below-banner-first">
          <h1> Our Innovative Machines</h1>
          <p>Discover the power and precision of our industry-leading machines, engineered to elevate your operations and drive exceptional results</p>
          <div className="below-banner-image">
            <div className="scrapper">
              <img src={scrapper} alt="" />
              <h1>PVC Scrapper Machine</h1>
              <p>Our machines are built to withstand the demands of the toughest environments
              </p>
            </div>
            <div className="extruder">
              <img src={extruder} alt="" />
              <h1>PVC Extruder Machine</h1>
              <p>At the heart of our company, we are committed to crafting machines that embody the highest standards of quality</p>
            </div>
          </div>
        </div>

        <div className="third">
          <div className="third-img">
            <img src={mixture} alt="" />
          </div>
          <div className="third-content">
            <h1>Elevating Your Construction </h1>
            <p>
              Experience the transformative power of our construction machines. Engineered with cutting-edge technology and built to withstand the rigors of the job site, our equipment is designed to streamline your operations, improve productivity
            </p>
            <Link to='/products'><button>Learn More</button></Link>
          </div>
        </div>
        <div className="fourth">
          <div className="forth-content">
            <p>Redefining the Future of Manufacturing
            </p>
            <h1>Innovative Solutions for a </h1>
            <p>As the world evolves, so too must the machines that drive progress. At our machine manufacturing company, we are at the forefront of innovation, constantly developing new technologies and engineering solutions that not only meet
            </p>
            <Link to='/products'><button>Discover Our Machine</button></Link>
          </div>
          <div className="forth-img">
            <img src={cutter} alt="" />
          </div>
        </div>
        <div className="fifth">
          <h1>Product Videos</h1>
          <div className="videos">
            <iframe width="560" height="315" src="https://www.youtube.com/embed/d-2oXKfmaBQ?si=SmOyEf5OKpXbrk4A" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>
            <iframe width="560" height="315" src="https://www.youtube.com/embed/d-2oXKfmaBQ?si=SmOyEf5OKpXbrk4A" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>
          </div>
        </div>
        <Contact />
      </div>
    </div>
  )
}

export default Home


{/* <img src={banner_image} alt="" />
        <h1>O.N ENGINEERING WORKS</h1>
        <p>"Welcome to O.N. Engineering Works in Bawana Industrial Area, Delhi! Specializing   in PVC machinery for over 35 years under the leadership of Mohd Osaid."</p>
        <div className="btn">
          <button className="banner-btn">Get Qutes!</button>
          <button className="banner-btn">Call Us!</button>
        </div>
      </div> */}