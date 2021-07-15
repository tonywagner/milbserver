#!/usr/bin/env node

// session.js defines the session class which handles API activity

// Required Node packages for the session class
const fs = require('fs')
const path = require('path')
const readlineSync = require('readline-sync')
const FileCookieStore = require('tough-cookie-filestore')

// Define some file paths and names
const DATA_DIRECTORY = path.join(__dirname, 'data')
const CACHE_DIRECTORY = path.join(__dirname, 'cache')

const CREDENTIALS_FILE = path.join(__dirname, 'credentials.json')
const COOKIE_FILE = path.join(DATA_DIRECTORY, 'cookies.json')
const DATA_FILE = path.join(DATA_DIRECTORY, 'data.json')
const CACHE_FILE = path.join(CACHE_DIRECTORY, 'cache.json')

// Default user agent to use for API requests
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.13; rv:87.0) Gecko/20100101 Firefox/87.0'

// Other variables to use in API communications
const PLATFORM = "macintosh"
const BAM_SDK_VERSION = '4.3'
const BAM_TOKEN_URL = 'https://us.edge.bamgrid.com/token'

class sessionClass {
  // Initialize the class
  constructor(debug = false) {
    this.debug = debug

    // Read credentials from file, if present
    this.credentials = this.readFileToJson(CREDENTIALS_FILE) || {}

    // Prompt for credentials if they don't exist
    if ( !this.credentials.username || !this.credentials.password ) {
      this.credentials.username = readlineSync.question('Enter username (email address): ')
      this.credentials.password = readlineSync.question('Enter password: ', { hideEchoBack: true })
      this.save_credentials()
    }

    // Create cookies json file if it doesn't exist
    this.createDirectory(DATA_DIRECTORY)
    this.createFile(COOKIE_FILE)

    // Set up http requests with the cookie jar
    this.request = require('request-promise')
    this.jar = this.request.jar(new FileCookieStore(COOKIE_FILE))
    this.request = this.request.defaults({timeout:15000, agent:false, jar: this.request.jar()})

    // Load session data and cache from files
    this.data = this.readFileToJson(DATA_FILE) || {}
    this.cache = this.readFileToJson(CACHE_FILE) || {}

    // Default linkType values
    if ( !this.data.linkType ) {
      this.setLinkType('embed')
    }
  }

  // Set the linkType
  // used for storing the desired page type across throughout site navigation
  setLinkType(x) {
    this.data.linkType = x
    this.save_session_data()
  }

  // Some basic self-explanatory functions
  createDirectory(directoryPath) {
    if (fs.existsSync(directoryPath) && !fs.lstatSync(directoryPath).isDirectory() ){
      fs.unlinkSync(directoryPath);
    }
    if (!fs.existsSync(directoryPath)){
      fs.mkdirSync(directoryPath);
    }
  }

  createFile(filePath) {
    if (!fs.existsSync(filePath)) {
      fs.closeSync(fs.openSync(filePath, 'w'))
    }
  }

  isValidJson(str) {
    try {
      JSON.parse(str);
    } catch (e) {
      return false;
    }
    return true;
  }

  readFileToJson(filePath) {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath))
    }
  }

  writeJsonToFile(jsonStr, filePath) {
    if (this.isValidJson(jsonStr)) {
      fs.writeFileSync(filePath, jsonStr)
    }
  }

  checkValidItem(item, obj) {
    if (obj.includes(item)) {
      return true
    }
    return false
  }

  returnValidItem(item, obj) {
    if (!obj.includes(item)) return obj[0]
    else return item
  }

  sortObj(obj) {
    return Object.keys(obj).sort().reduce(function (result, key) {
      result[key] = obj[key];
      return result;
    }, {});
  }

  localTimeString() {
    let curDate = new Date()
    return curDate.toLocaleString()
  }

  // the live date is today's date, or if before a specified hour UTC time, then use yesterday's date
  liveDate(hour = 10) {
    let curDate = new Date()
    if ( curDate.getUTCHours() < hour ) {
      curDate.setDate(curDate.getDate()-1)
    }
    return curDate.toISOString().substring(0,10)
  }

  yesterdayDate() {
    let curDate = new Date(this.liveDate())
    curDate.setDate(curDate.getDate()-1)
    return curDate.toISOString().substring(0,10)
  }

  convertDateToXMLTV(x) {
    let newDate = String(x.getFullYear()) + String(x.getMonth() + 1).padStart(2, '0') + String(x.getDate()).padStart(2, '0') + String(x.getHours()).padStart(2, '0') + String(x.getMinutes()).padStart(2, '0') + String(x.getSeconds()).padStart(2, '0') + " "
    let offset = x.getTimezoneOffset()
    if ( offset > 0 ) {
      newDate += "-"
    } else {
      newDate += "+"
    }
    newDate += String((offset / 60)).padStart(2, '0') + "00"
    return newDate
  }

  convertDateStringToObjectName(dateString) {
    return 'd' + this.dateWithoutDashes(dateString)
  }

  getCacheUpdatedDate(dateString) {
    return this.cache.dates[convertDateStringToObjectName(dateString)].updated
  }

  setDateCacheExpiry(cache_name, expiryDate) {
    if ( !this.cache.dates ) {
      this.cache.dates={}
    }
    if ( !this.cache.dates[cache_name] ) {
      this.cache.dates[cache_name] = {}
    }
    this.cache.dates[cache_name].dateCacheExpiry = expiryDate
    this.cache.dates[cache_name].updated = this.localTimeString()
    this.save_cache_data()
  }

  createMediaCache(gamePk) {
    if ( !this.data.media ) {
      this.data.media = {}
    }
    if ( !this.data.media[gamePk] ) {
      this.data.media[gamePk] = {}
    }
  }

  cacheStreamURL(gamePk, streamURL) {
    this.createMediaCache(gamePk)
    this.data.media[gamePk].streamURL = streamURL
    this.save_session_data()
  }

  dateWithoutDashes(dateString) {
    return dateString.substr(0,4) + dateString.substr(5,2) + dateString.substr(8,2)
  }

  log(msg) {
    console.log(this.localTimeString() + ' ' + msg)
  }

  debuglog(msg) {
    if (this.debug) this.log(msg)
  }

  halt(msg) {
    this.log(msg)
    process.exit(1)
  }

  logout() {
    try {
      fs.unlinkSync(CREDENTIALS_FILE)
    } catch(e){
      //this.halt('logout error : ' + e.message)
    }
  }

  clear_session_data() {
    try {
      fs.unlinkSync(COOKIE_FILE)
      fs.unlinkSync(DATA_FILE)
    } catch(e){
      //this.halt('reset session error : ' + e.message)
    }
  }

  clear_cache() {
    try {
      fs.unlinkSync(CACHE_FILE)
    } catch(e){
      //this.halt('clear cache error : ' + e.message)
    }
  }

  save_credentials() {
    this.writeJsonToFile(JSON.stringify(this.credentials), CREDENTIALS_FILE)
    this.debuglog('credentials saved to file')
  }

  save_session_data() {
    this.createDirectory(DATA_DIRECTORY)
    this.writeJsonToFile(JSON.stringify(this.data), DATA_FILE)
    this.debuglog('session data saved to file')
  }

  save_cache_data() {
    this.createDirectory(CACHE_DIRECTORY)
    this.writeJsonToFile(JSON.stringify(this.cache), CACHE_FILE)
    this.debuglog('cache data saved to file')
  }

  save_cache_file(cache_name, cache_data) {
    this.createDirectory(CACHE_DIRECTORY)
    this.writeJsonToFile(JSON.stringify(cache_data), path.join(CACHE_DIRECTORY, cache_name+'.json'))
    this.debuglog('cache file saved')
  }

  // Generate a random string of specified length
  getRandomString(length) {
    var s = ''
    do {
      s += Math.random().toString(36).substr(2);
    } while (s.length < length)
    s = s.substr(0, length)

    return s
  }

  // Generic http GET request function
  httpGet(reqObj) {
    reqObj.jar = this.jar
    return new Promise((resolve, reject) => {
      this.request.get(reqObj)
      .then(function(body) {
        resolve(body)
      })
      .catch(function(e) {
        console.error('http get failed : ' + e.message)
        console.error(reqObj)
        process.exit(1)
      })
    })
  }

  // Generic http POST request function
  httpPost(reqObj) {
    reqObj.jar = this.jar
    return new Promise((resolve, reject) => {
      this.request.post(reqObj)
      .then(function(body) {
        resolve(body)
      })
      .catch(function(e) {
        console.error('http post failed : ' + e.message)
        console.error(reqObj)
        process.exit(1)
      })
    })
  }

  // request to use when fetching videos
  streamVideo(u, opts, cb) {
    opts.jar = this.jar
    opts.headers = {
      'Origin': 'https://www.milb.com',
      'Referer': 'https://www.milb.com/',
      'User-Agent': USER_AGENT
    }
    this.request(u, opts, cb)
  }

  // API call
  async getOktaClientId() {
    this.debuglog('getOktaClientId')
    if ( !this.data.oktaClientId ) {
      this.debuglog('need to get oktaClientId')
      let reqObj = {
        url: 'https://www.milb.com/live-stream-games',
        headers: {
          'User-agent': USER_AGENT,
          'Origin': 'https://www.milb.com',
          'Referer': 'https://www.milb.com/',
          'Accept-Encoding': 'gzip, deflate, br'
        },
        gzip: true
      }
      var response = await this.httpGet(reqObj)
      // disabled because it's very big!
      //this.debuglog('getOktaClientId response : ' + response)
      var parsed = response.match('"clientId":"([^"]+)",')
      if ( parsed[1] ) {
        this.data.oktaClientId = parsed[1]
        this.save_session_data()
        return this.data.oktaClientId
      }
    } else {
      return this.data.oktaClientId
    }
  }

  // API call
  async getStreamURL(gamePk) {
    this.debuglog('getStreamURL from ' + gamePk)
    if ( this.data.media && this.data.media[gamePk] && this.data.media[gamePk].streamURL ) {
      this.debuglog('using cached streamURL')
      return this.data.media[gamePk].streamURL
    } else {
      let playbackURL = 'https://services.mediaservices.mlbinfra.com/api/v1/playback/' + gamePk + '?sdp=WEB_MEDIAPLAYER'
      let reqObj = {
        url: playbackURL,
        simple: false,
        headers: {
          'Authorization': 'Bearer ' + await this.getOktaAccessToken() || this.halt('missing oktaAccessToken'),
          'User-agent': USER_AGENT,
          'Accept': '*/*',
          'Origin': 'https://www.milb.com',
          'Referer': 'https://www.milb.com/',
          'Accept-Encoding': 'gzip, deflate, br',
          'Content-type': 'application/json'
        },
        gzip: true
      }
      var response = await this.httpGet(reqObj)
      if ( this.isValidJson(response) ) {
        this.debuglog('getStreamURL response : ' + response)
        let obj = JSON.parse(response)
        if ( obj.success && obj.data && obj.data[0] && obj.data[0].name && (obj.data[0].name == 'url') && obj.data[0].value ) {
          var streamURL = obj.data[0].value
          this.debuglog('getStreamURL : ' + streamURL)
          this.cacheStreamURL(gamePk, streamURL)
          return streamURL
        }
      }
    }
  }

  async getOktaAccessToken() {
    // repeat up to 4 times
    for (var i = 0; i < 4; i++) {
      this.debuglog('getOktaAccessToken')
      let oktaAccessToken = await this.retrieveOktaAccessToken()
      if ( oktaAccessToken ) return oktaAccessToken
    }
  }

  // API call
  async retrieveOktaAccessToken() {
    this.debuglog('retrieveOktaAccessToken')
    if ( !this.data.oktaAccessToken || !this.data.oktaAccessTokenExpiry || (this.data.oktaAccessTokenExpiry < new Date()) ) {
      this.debuglog('need to get oktaAccessToken')
      let state = this.getRandomString(64)
      let nonce = this.getRandomString(64)
      let reqObj = {
        url: 'https://ids.milb.com/oauth2/aus9hfi7yyG0nCpgc356/v1/authorize',
        headers: {
          'User-Agent': USER_AGENT,
          'Accept-Encoding': 'identity',
          'Referer': 'https://www.milb.com/',
          'Origin': 'https://www.milb.com'
        },
        qs: {
          'client_id': await this.getOktaClientId() || this.halt('missing oktaClientId'),
          'redirect_uri': 'https://www.milb.com/login',
          'response_type': 'id_token token',
          'response_mode': 'okta_post_message',
          'state': state,
          'nonce': nonce,
          'prompt': 'none',
          'sessionToken': await this.getAuthnSessionToken() || this.halt('missing authnSessionToken'),
          'scope': 'openid email'
        }
      }
      var response = await this.httpGet(reqObj)
      var str = response.toString()
      this.debuglog('retrieveOktaAccessToken response : ' + str)
      if ( str.match ) {
        var errorParsed = str.match("data.error = 'login_required'")
        if ( errorParsed ) {
          // Need to log in again
          this.log('Logging in...')
          this.data.authnSessionToken = null
          this.save_session_data()
          return false
        } else {
          var parsed = str.match("data.access_token = '([^']+)'")
          if ( parsed && parsed[1] ) {
            let oktaAccessToken = parsed[1].split('\\x2D').join('-')
            this.debuglog('retrieveOktaAccessToken : ' + oktaAccessToken)
            this.data.oktaAccessToken = oktaAccessToken
            parsed = str.match("data.expires_in = '([^']+)'")
            this.data.oktaAccessTokenExpiry = Date.parse(new Date().getTime() + parsed[1] * 1000)
            return this.data.oktaAccessToken
          }
        }
      }
    } else {
      return this.data.oktaAccessToken
    }
  }

  // API call
  async getAuthnSessionToken() {
    this.debuglog('getAuthnSessionToken')
    if ( !this.data.authnSessionToken || !this.data.authnSessionTokenExpiry || (this.data.authnSessionTokenExpiry < new Date()) ) {
      this.debuglog('need to get authnSessionToken')
      let reqObj = {
        url: 'https://ids.milb.com/api/v1/authn',
        headers: {
          'User-Agent': USER_AGENT,
          'Accept-Encoding': 'identity',
          'Content-Type': 'application/json',
          'Referer': 'https://www.milb.com/',
          'Origin': 'https://www.milb.com'
        },
        json: {
          'username': this.credentials.username || this.halt('missing username'),
          'password': this.credentials.password || this.halt('missing password'),
          'options': {
            'multiOptionalFactorEnroll': false,
            'warnBeforePasswordExpired': true
          }
        }
      }
      var response = await this.httpPost(reqObj)
      if ( response.sessionToken ) {
        this.debuglog('getAuthnSessionToken response : ' + JSON.stringify(response))
        this.debuglog('getAuthnSessionToken : ' + response.sessionToken)
        this.data.authnSessionToken = response.sessionToken
        this.data.authnSessionTokenExpiry = Date.parse(response.expiresAt)
        this.save_session_data()
        return this.data.authnSessionToken
      }
    } else {
      return this.data.authnSessionToken
    }
  }

  // get data for a day, either from cache or an API call
  async getDayData(dateString, level_ids, team_ids) {
    try {
      this.debuglog('getDayData for ' + dateString)

      let cache_data
      let cache_name = this.convertDateStringToObjectName(dateString)
      cache_name += '.' + level_ids
      if ( team_ids != '' ) cache_name += '.' + team_ids
      let cache_file = path.join(CACHE_DIRECTORY, cache_name+'.json')
      let currentDate = new Date()
      if ( !fs.existsSync(cache_file) || !this.cache || !this.cache.dates || !this.cache.dates[cache_name] || !this.cache.dates[cache_name].dateCacheExpiry || (currentDate > new Date(this.cache.dates[cache_name].dateCacheExpiry)) ) {
        let url = 'https://bdfed.stitch.mlbinfra.com/bdfed/transform-mlb-scoreboard?stitch_env=prod&sortTemplate=2&sportId=' + level_ids + '&startDate=' + dateString + '&endDate=' + dateString + '&gameType=E&&gameType=S&&gameType=R&&gameType=F&&gameType=D&&gameType=L&&gameType=W&&gameType=A&language=en'
        if ( team_ids != '' ) url += '&teamIds=' + team_ids
        let reqObj = {
          url: url,
          headers: {
            'User-agent': USER_AGENT,
            'Origin': 'https://www.milb.com',
            'Referer': 'https://www.milb.com/',
            'Accept-Encoding': 'gzip, deflate, br',
            'Content-type': 'application/json'
          },
          gzip: true
        }
        var response = await this.httpGet(reqObj)
        if ( this.isValidJson(response) ) {
          //this.debuglog(response)
          cache_data = JSON.parse(response)
          this.save_cache_file(cache_name, cache_data)

          // Default cache period is 1 hour
          let oneHourFromNow = new Date()
          oneHourFromNow.setHours(oneHourFromNow.getHours()+1)
          let dateCacheExpiry = oneHourFromNow

          let today = this.liveDate()
          let yesterday = this.yesterdayDate()
          if ( dateString == today ) {
            let finals = false
            for (var i = 0; i < cache_data.dates[0].games.length; i++) {
              if ( ((cache_data.dates[0].games[i].status.abstractGameState == 'Live') && (cache_data.dates[0].games[i].status.detailedState.indexOf('Suspended') != 0)) || ((cache_data.dates[0].games[i].status.startTimeTBD == true) && (cache_data.dates[0].games[i].status.abstractGameState != 'Final') && (cache_data.dates[0].games[i-1].status.abstractGameState == 'Final')) ) {
                this.debuglog('setting cache expiry to 1 minute due to in progress games or upcoming TBD game')
                currentDate.setMinutes(currentDate.getMinutes()+1)
                dateCacheExpiry = currentDate
                break
              } else if ( cache_data.dates[0].games[i].status.abstractGameState == 'Final' ) {
                finals = true
              } else if ( (finals == false) && (cache_data.dates[0].games[i].status.startTimeTBD == false) ) {
                let nextGameDate = new Date(cache_data.dates[0].games[i].gameDate)
                nextGameDate.setMinutes(nextGameDate.getMinutes()-15)
                this.debuglog('setting cache expiry to 15 minutes before next live game')
                dateCacheExpiry = nextGameDate
                break
              }
            }
          } else if ( dateString > today ) {
            this.debuglog('1+ days in the future, setting cache expiry to tomorrow')
            let tomorrowDate = new Date(today)
            tomorrowDate.setDate(tomorrowDate.getDate()+1)
            let utcHours = 10
            tomorrowDate.setHours(tomorrowDate.getHours()+utcHours)
            dateCacheExpiry = tomorrowDate
          } else if ( dateString < yesterday ) {
            this.debuglog('2+ days old, setting cache expiry to forever')
            dateCacheExpiry = new Date(8640000000000000)
          }

          // finally save the setting
          this.setDateCacheExpiry(cache_name, dateCacheExpiry)
        } else {
          this.log('error : invalid json from url ' + getObj.url)
        }
      } else {
        this.debuglog('using cached date data')
        cache_data = this.readFileToJson(cache_file)
      }
      if (cache_data) {
        return cache_data
      }
    } catch(e) {
      this.log('getDayData error : ' + e.message)
    }
  }

  // Get image from cache or request
  async getImage(teamId) {
    this.debuglog('getImage ' + teamId)
    let imagePath = path.join(CACHE_DIRECTORY, teamId + '.svg')
    if ( fs.existsSync(imagePath) ) {
      this.debuglog('using cached image for ' + teamId)
      return fs.readFileSync(imagePath)
    } else {
      this.debuglog('requesting new image for ' + teamId)
      let imageURL = 'https://www.mlbstatic.com/team-logos/' + teamId + '.svg'
      if ( teamId == 'MILB' ) {
        imageURL = 'https://www.mlbstatic.com/team-logos/league-on-dark/milb-alt.svg'
      }
      let reqObj = {
        url: imageURL,
        headers: {
          'User-Agent': USER_AGENT,
          'Origin': 'https://www.milb.com',
          'Referer': 'https://www.milb.com/'
        }
      }
      var response = await this.httpGet(reqObj)
      if ( response ) {
        this.debuglog('getImage response : ' + response)
        fs.writeFileSync(imagePath, response)
      } else {
        this.debuglog('failed to get image for ' + teamId)
      }
    }
  }

}

module.exports = sessionClass