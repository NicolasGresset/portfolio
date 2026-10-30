// redirect.js - Old location.html links lead to rendez-vous.html, keeping their query and hash
location.replace(`rendez-vous${location.search}${location.hash}`);
