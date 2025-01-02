import logo from './logo.svg';
import './App.css';
import Navbar from './components/Navbar/Navbar';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Home from '../src/Pages/Home'
import Products from './Pages/Products';
import Contac from './Pages/Contac';
import About from './Pages/About';
import Welcome from './components/Welcome/Welcome';
import Footer from './components/footer/Footer';
import ProductShow from './Pages/ProductShow';
import ShopContextProvider from './Context/ShopContext';


function App() {
  return (
    <>
      <ShopContextProvider>
        <BrowserRouter>
          <Welcome />
          <Navbar />
          <Routes>
            <Route path='/' element={<Home />} />
            <Route path='/products' element={<Products />} />
            {/* Routing for indivisual products below */}
            <Route path="/product" element={<ProductShow />}>
              <Route path=':productId' element={<ProductShow />} />
            </Route>
            <Route path='/contact' element={<Contac />} />
            <Route path='/about' element={<About />} />
          </Routes>
        </BrowserRouter >
        <Footer />
      </ShopContextProvider>
    </>
  );
}

export default App;
