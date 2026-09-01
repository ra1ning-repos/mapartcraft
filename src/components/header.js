import React, { Component } from "react";

import "./header.css";

class Header extends Component {
  render() {
    return (
      <div className="header">
        <h3>{"RA1NING's version"}</h3>
        <p>
          {"a "}
          <a href="https://github.com/ra1ning-repos/mapartcraft" target="_blank" rel="noopener noreferrer">
            fork
          </a>
          {" of mike2b2t's "}
          <a href="https://mike2b2t.github.io/mapartcraft" target="_blank" rel="noopener noreferrer">
            fork
          </a>
          {" of "}
          <a href="https://rebane2001.com/mapartcraft" target="_blank" rel="noopener noreferrer">
            mapartcraft
          </a>
        </p>
      </div>
    );
  }
}

export default Header;
