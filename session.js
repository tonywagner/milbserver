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
const PROTECTION_FILE = path.join(__dirname, 'protection.json')
const COOKIE_FILE = path.join(DATA_DIRECTORY, 'cookies.json')
const DATA_FILE = path.join(DATA_DIRECTORY, 'data.json')
const CACHE_FILE = path.join(CACHE_DIRECTORY, 'cache.json')

// Default user agent to use for API requests
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.13; rv:87.0) Gecko/20100101 Firefox/87.0'

// Other variables to use in API communications
const PLATFORM = "macintosh"
const BAM_SDK_VERSION = '4.3'
const BAM_TOKEN_URL = 'https://us.edge.bamgrid.com/token'

// Default date handling
const TODAY_UTC_HOURS = 8 // UTC hours (EST + 4) into tomorrow to still use today's date

// First is default level, last should be All (also used as default org)
const LEVELS = { 'AAA': '11', 'AA': '12', 'A+': '13', 'A': '14', 'All': '11,12,13,14' }

// These are the events to ignore, if we're skipping breaks
const BREAK_TYPES = ['Game Advisory', 'Pitching Substitution', 'Offensive Substitution', 'Defensive Sub', 'Defensive Switch', 'Runner Placed On Base']
// These are the events to keep, in addition to the last event of each at-bat, if we're skipping pitches
const ACTION_TYPES = ['Wild Pitch', 'Passed Ball', 'Stolen Base', 'Caught Stealing', 'Pickoff', 'Error', 'Out', 'Balk', 'Defensive Indiff']
const EVENT_START_PADDING = 4
const EVENT_END_PADDING = 17
const MINIMUM_BREAK_DURATION = 10

class sessionClass {
  // Initialize the class
  constructor(argv = {}) {
    this.debug = argv.debug

    // Read credentials from file, if present
    this.credentials = this.readFileToJson(CREDENTIALS_FILE) || {}

    // Check if account credentials were provided and if they are different from the stored credentials
    if ( argv.account_username && argv.account_password && ((argv.account_username != this.credentials.account_username) || (argv.account_password != this.credentials.account_password)) ) {
      this.debuglog('updating account credentials')
      this.credentials.account_username = argv.account_username
      this.credentials.account_password = argv.account_password
      this.save_credentials()
      this.clear_session_data()
    } else {
      // Prompt for credentials if they don't exist
      if ( !this.credentials.account_username || !this.credentials.account_password ) {
        this.debuglog('prompting for account credentials')
        this.credentials.account_username = readlineSync.question('Enter account username (email address): ')
        this.credentials.account_password = readlineSync.question('Enter account password: ', { hideEchoBack: true })
        this.save_credentials()
        this.clear_session_data()
      }
    }

    // If page username/password protection is specified, retrieve or generate a random string of random length
    // to protect non-page content (streams, playlists, guides, images)
    this.protection = {}
    if ( argv.page_username && argv.page_password ) {
      // Read protection data from file, if present
      this.protection = this.readFileToJson(PROTECTION_FILE) || {}

      // Check if content_protect key was provided and if it is different from the stored one
      if ( argv.content_protect && (argv.content_protect != this.protection.content_protect) ) {
        this.log('using specified content protection key')
        this.log('you may need to update any content URLs you have copied outside of mlbserver')
        this.protection.content_protect = argv.content_protect
      } else {
        // Generate a content_protect key if it doesn't exist
        if ( !this.protection.content_protect ) {
          this.log('generating new content protection key')
          this.log('** YOU WILL NEED TO UPDATE ANY CONTENT URLS YOU HAVE COPIED OUTSIDE OF MLBSERVER **')
          this.protection.content_protect = this.getRandomString(this.getRandomInteger(32,64))
          this.save_protection()
        }
      }
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

    // Define empty temporary cache (for inning data)
    this.temp_cache = {}

    // Default scan_mode and linkType values
    if ( !this.data.scan_mode ) {
      this.setScanMode('on')
    }
    if ( !this.data.linkType ) {
      this.setLinkType('embed')
    }
  }

  // Set the scan_mode
  // "on" will return the sample stream for all live channels.m3u stream requests
  setScanMode(x) {
    this.log('scan_mode set to ' + x)
    this.data.scan_mode = x
    this.save_session_data()
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

  getTodayUTCHours() {
    return TODAY_UTC_HOURS
  }

  getUserAgent() {
    return USER_AGENT
  }

  getLevels() {
    return LEVELS
  }

  // get parent org nickname
  getParent(parent) {
    let long_orgs = [ 'Jays', 'Sox' ]
    let parent_array = parent.split(' ')
    parent = parent_array[parent_array.length-1]
    if ( long_orgs.includes(parent) ) {
      parent = parent_array[parent_array.length-2] + ' ' + parent
    }
    return parent
  }

  // the live date is today's date, or if before a specified hour (UTC time), then use yesterday's date
  liveDate(hour = TODAY_UTC_HOURS) {
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

  getCacheUpdatedDate(dateString) {
    return this.cache.dates[dateString].updated
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

  setGamedayCacheExpiry(cache_name, expiryDate) {
    if ( !this.cache.gameday ) {
      this.cache.gameday={}
    }
    if ( !this.cache.gameday[cache_name] ) {
      this.cache.gameday[cache_name] = {}
    }
    this.cache.gameday[cache_name].gamedayCacheExpiry = expiryDate
    this.save_cache_data()
  }

  createMediaCache(gamePk) {
    if ( !this.cache.media ) {
      this.cache.media = {}
    }
    if ( !this.cache.media[gamePk] ) {
      this.cache.media[gamePk] = {}
    }
  }

  cacheStreamURL(gamePk, streamURL) {
    this.createMediaCache(gamePk)
    this.cache.media[gamePk].streamURL = streamURL
    // Expire it in 1 minute
    let seconds_to_expire = 60
    this.cache.media[gamePk].streamURLExpiry = new Date(new Date().getTime() + seconds_to_expire * 1000)
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
      this.debuglog('credentials cannot be cleared or do not exist yet : ' + e.message)
    }
  }

  clear_session_data() {
    try {
      fs.unlinkSync(COOKIE_FILE)
      fs.unlinkSync(DATA_FILE)
    } catch(e){
      this.debuglog('session cannot be cleared or does not exist yet : ' + e.message)
    }
  }

  clear_cache() {
    try {
      fs.unlinkSync(CACHE_FILE)
    } catch(e){
      this.debuglog('cache cannot be cleared or does not exist yet : ' + e.message)
    }
  }

  save_credentials() {
    this.writeJsonToFile(JSON.stringify(this.credentials), CREDENTIALS_FILE)
    this.debuglog('credentials saved to file')
  }

  save_protection() {
    this.writeJsonToFile(JSON.stringify(this.protection), PROTECTION_FILE)
    this.debuglog('protection data saved to file')
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

  save_json_cache_file(cache_name, cache_data) {
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
  streamVideo(u, opts, tries, cb) {
    opts.jar = this.jar
    opts.headers = {
      'Origin': 'https://www.milb.com',
      'Referer': 'https://www.milb.com/',
      'User-Agent': USER_AGENT
    }
    if ( opts.referer ) {
      opts.headers['Referer'] = opts.referer
    }
    if ( opts.origin ) {
      opts.headers['Origin'] = opts.origin
    }
    this.request(u, opts, cb)
    .catch(function(e) {
      let curDate = new Date()
      console.error(curDate.toLocaleString() + ' stream video failed on url : ' + u)
      console.error(curDate.toLocaleString() + ' stream video failed with error : ' + e.message.toString())
      if ( tries == 1 ) process.exit(1)
    })
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
    if ( this.cache.media && this.cache.media[gamePk] && this.cache.media[gamePk].streamURL && this.cache.media[gamePk].streamURLExpiry && (Date.parse(this.cache.media[gamePk].streamURLExpiry) > new Date()) ) {
      this.debuglog('using cached streamURL')
      return this.cache.media[gamePk].streamURL
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
    if ( !this.data.oktaAccessToken || !this.data.oktaAccessTokenExpiry || (Date.parse(this.data.oktaAccessTokenExpiry) < new Date()) ) {
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
          var parsed_token = str.match("data.access_token = '([^']+)'")
          var parsed_expiry = str.match("data.expires_in = '([^']+)'")
          if ( parsed_token && parsed_token[1] && parsed_expiry && parsed_expiry[1] ) {
            let oktaAccessToken = parsed_token[1].split('\\x2D').join('-')
            let oktaAccessTokenExpiry = parsed_expiry[1]
            this.debuglog('retrieveOktaAccessToken : ' + oktaAccessToken)
            this.debuglog('retrieveOktaAccessToken expires in : ' + oktaAccessTokenExpiry)
            this.data.oktaAccessToken = oktaAccessToken
            this.data.oktaAccessTokenExpiry = new Date(new Date().getTime() + oktaAccessTokenExpiry * 1000)
            this.save_session_data()
            return this.data.oktaAccessToken
          } else {
            this.log('retrieveOktaAccessToken parse failure')
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
          'username': this.credentials.account_username || this.halt('missing username'),
          'password': this.credentials.account_password || this.halt('missing password'),
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

  // get gamePk for a live channel request
  async getGamePk(team_id, mediaDate, gameNumber) {
    try {
      this.debuglog('getGamePk')

      let mediaType = 'MiLBTV'

      let gameDate = this.liveDate()
      if ( mediaDate == 'yesterday' ) {
        gameDate = this.yesterdayDate()
      } else if ( (mediaDate) && (mediaDate != 'today') ) {
        gameDate = mediaDate
      }

      let gamePk = false

      // Just get data for this level/team
      let cache_data
      cache_data = await this.getDayData(gameDate, '', team_id)

      for (var j = 0; j < cache_data.dates[0].games.length; j++) {
        if ( gamePk ) break
        if ( (typeof cache_data.dates[0].games[j] !== 'undefined') && cache_data.dates[0].games[j].content && cache_data.dates[0].games[j].content.media && cache_data.dates[0].games[j].content.media.epg ) {
          for (var k = 0; k < cache_data.dates[0].games[j].content.media.epg.length; k++) {
            if ( gamePk ) break
            if ( cache_data.dates[0].games[j].content.media.epg[k].title == mediaType ) {
              for (var x = 0; x < cache_data.dates[0].games[j].content.media.epg[k].items.length; x++) {
                if ( (team_id == cache_data.dates[0].games[j].teams['home'].team.id) || (team_id == cache_data.dates[0].games[j].teams['away'].team.id) ) {
                  if ( gameNumber && (gameNumber > 1) ) {
                    this.debuglog('matched team for game number 1')
                    gameNumber--
                  } else {
                    this.debuglog('matched team for event')
                    if ( (cache_data.dates[0].games[j].content.media.epg[k].items[x].mediaState == 'MEDIA_ON') || ((mediaDate) && ((cache_data.dates[0].games[j].content.media.epg[k].items[x].mediaState == 'MEDIA_ARCHIVE') || (cache_data.dates[0].games[j].status.abstractGameState == 'Final'))) ) {
                      gamePk = cache_data.dates[0].games[j].gamePk
                    } else {
                      this.log('event video not yet available')
                    }
                    break
                  }
                }
              }
            }
          }
        }

        if (gamePk) {
          return gamePk
        }
      }
      this.log('could not find gamePk')
    } catch(e) {
      this.log('getGamePk error : ' + e.message)
    }
  }

  // get data for a day, either from cache or an API call
  async getDayData(dateString, level_ids, team_ids) {
    try {
      let cache_data
      let cache_name = dateString
      if (level_ids == '') {
        level_ids = LEVELS['All']
      }
      this.debuglog('getDayData for date ' + dateString + ', levels ' + level_ids + ', teams ' + team_ids)
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
          this.save_json_cache_file(cache_name, cache_data)

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

  // get data for 3 weeks, either from cache or an API call
  async getWeeksData() {
    try {
      this.debuglog('getWeeksData')

      // use 5 AM UTC time as the threshold to advance 1 day
      let utcHours = 5

      let cache_data
      let cache_name = 'week'
      let cache_file = path.join(CACHE_DIRECTORY, cache_name + '.json')
      let currentDate = new Date()
      if ( !fs.existsSync(cache_file) || !this.cache || !this.cache.weekCacheExpiry || (currentDate > new Date(this.cache.weekCacheExpiry)) ) {
        let startDate = this.liveDate(utcHours)
        let endDate = new Date(startDate)
        endDate.setDate(endDate.getDate()+20)
        endDate = endDate.toISOString().substring(0,10)
        let reqObj = {
          url: 'https://statsapi.mlb.com/api/v1/schedule?sportId=' + LEVELS['All'] + '&startDate=' + startDate + '&endDate=' + endDate + '&gameTypes=A,R,F,D,L,W,C&hydrate=broadcasts,probablePitcher,team&language=en',
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
          this.save_json_cache_file(cache_name, cache_data)
          this.debuglog('setting channels cache expiry to next day')
          let nextDate = new Date(startDate)
          nextDate.setDate(nextDate.getDate()+1)
          nextDate.setHours(nextDate.getHours()+utcHours)
          this.cache.weekCacheExpiry = nextDate
          this.save_cache_data()
        } else {
          this.log('error : invalid json from url ' + reqObj.url)
        }
      } else {
        this.debuglog('using cached channel data')
        cache_data = this.readFileToJson(cache_file)
      }
      if (cache_data) {
        return cache_data
      }
    } catch(e) {
      this.log('getWeeksData error : ' + e.message)
    }
  }

  // get live channels in M3U format
  async getChannels(includeTeams, includeOrgs, server, resolution, pipe, startingChannelNumber) {
    try {
      this.debuglog('getChannels')

      let mediaType = 'MiLBTV'

      let cache_data = await this.getWeeksData()
      if (cache_data) {
        var channels = {}
        for (var i = 0; i < cache_data.dates.length; i++) {
          for (var j = 0; j < cache_data.dates[i].games.length; j++) {
            // Begin MiLB games
            let broadcast = false
            if ( typeof cache_data.dates[i].games[j].broadcasts !== 'undefined' ) {
              for (var k = 0; k < cache_data.dates[i].games[j].broadcasts.length; k++) {
                if ( cache_data.dates[i].games[j].broadcasts[k].name == 'MiLB.TV' ) {
                  broadcast = true
                  break
                }
              }
            }
            if ( broadcast == true ) {
              let home_team_id = cache_data.dates[i].games[j].teams['home'].team.id
              let away_team_id = cache_data.dates[i].games[j].teams['away'].team.id
              let home_parent = this.getParent(cache_data.dates[i].games[j].teams['home'].team.parentOrgName)
              let away_parent = this.getParent(cache_data.dates[i].games[j].teams['away'].team.parentOrgName)
              if ( ((includeTeams.length == 0) && (includeOrgs.length == 0)) || includeTeams.includes(home_team_id) || includeTeams.includes(away_team_id) || includeOrgs.includes(home_parent) || includeOrgs.includes(away_parent) ) {
                let team_id = home_team_id
                if ( includeTeams.includes(away_team_id) || includeOrgs.includes(away_parent) ) {
                  team_id = away_team_id
                }
                let icon = server + '/image.svg?teamId=' + team_id
                if ( this.protection.content_protect ) icon += '&content_protect=' + this.protection.content_protect
                let channelid = mediaType + '.' + team_id
                let stream = server + '/stream.m3u8?teamId=' + encodeURIComponent(team_id)
                stream += '&resolution=' + resolution
                if ( this.protection.content_protect ) stream += '&content_protect=' + this.protection.content_protect
                if ( pipe == 'true' ) {
                  stream = 'pipe://ffmpeg -hide_banner -loglevel fatal -i "' + stream + '" -map 0:v -map 0:a -c copy -metadata service_provider="' + mediaType + '" -metadata service_name="' + channelid + '" -f mpegts pipe:1'
                }
                channels[channelid] = {}
                channels[channelid].channellogo = icon
                channels[channelid].stream = stream
                channels[channelid].mediatype = mediaType
              }
            }
          }
        }
        channels = this.sortObj(channels)

        let channelnumber = startingChannelNumber
        var body = '#EXTM3U' + "\n"
        //body += '#EXTINF:-1 CUID="MILBSERVER.SAMPLE.VIDEO" tvg-id="MILBSERVER.SAMPLE.VIDEO" tvg-name="MILBSERVER.SAMPLE.VIDEO",MILBSERVER SAMPLE VIDEO' + "\n"
        //body += '/stream.m3u8' + "\n"
        for (const [key, value] of Object.entries(channels)) {
          body += '#EXTINF:-1 CUID="' + key + '" channelID="' + key + '" tvg-num="1.' + channelnumber + '" tvg-chno="1.' + channelnumber + '" tvg-id="' + key + '" tvg-name="' + key + '" tvg-logo="' + value.channellogo + '" group-title="' + value.mediatype + '",' + key + "\n"
          body += value.stream + "\n"
          channelnumber++
        }
        return body
      }
    } catch(e) {
      this.log('getChannels error : ' + e.message)
    }
  }

  // get guide.xml file, in XMLTV format
  async getGuide(includeTeams, includeOrgs, server) {
    try {
      this.debuglog('getGuide')

      let mediaType = 'MiLBTV'

      let cache_data = await this.getWeeksData()
      if (cache_data) {
        var channels = {}
        var programs = ""
        for (var i = 0; i < cache_data.dates.length; i++) {
          for (var j = 0; j < cache_data.dates[i].games.length; j++) {
            // Begin MiLB games
            let broadcast = false
            if ( typeof cache_data.dates[i].games[j].broadcasts !== 'undefined' ) {
              for (var k = 0; k < cache_data.dates[i].games[j].broadcasts.length; k++) {
                if ( cache_data.dates[i].games[j].broadcasts[k].name == 'MiLB.TV' ) {
                  broadcast = true
                  break
                }
              }
            }
            if ( broadcast == true ) {
              let home_team_id = cache_data.dates[i].games[j].teams['home'].team.id
              let away_team_id = cache_data.dates[i].games[j].teams['away'].team.id
              let home_parent = this.getParent(cache_data.dates[i].games[j].teams['home'].team.parentOrgName)
              let away_parent = this.getParent(cache_data.dates[i].games[j].teams['away'].team.parentOrgName)
              if ( ((includeTeams.length == 0) && (includeOrgs.length == 0)) || includeTeams.includes(home_team_id) || includeTeams.includes(away_team_id) || includeOrgs.includes(home_parent) || includeOrgs.includes(away_parent) ) {
                let team_id = home_team_id
                if ( includeTeams.includes(away_team_id) || includeOrgs.includes(away_parent) ) {
                  team_id = away_team_id
                }
                let icon = server + '/image.svg?teamId=' + team_id
                if ( this.protection.content_protect ) icon += '&content_protect=' + this.protection.content_protect
                let channelid = mediaType + '.' + team_id
                channels[channelid] = {}
                channels[channelid].name = channelid
                channels[channelid].icon = icon

                let awayteam = cache_data.dates[i].games[j].teams['away'].team.shortName + ' (' + away_parent + ')'
                let hometeam = cache_data.dates[i].games[j].teams['home'].team.shortName + ' (' + home_parent + ')'

                let title = 'MiLB Baseball: ' + awayteam + ' at ' + hometeam

                let description = cache_data.dates[i].games[j].teams['home'].team.sport.name + ' ' + cache_data.dates[i].games[j].teams['home'].team.league.name + '. '
                if ( cache_data.dates[i].games[j].doubleHeader != 'N' ) {
                  description += 'Game ' + cache_data.dates[i].games[j].gameNumber + '. '
                }
                if ( (cache_data.dates[i].games[j].teams['away'].probablePitcher && cache_data.dates[i].games[j].teams['away'].probablePitcher.fullName) || (cache_data.dates[i].games[j].teams['home'].probablePitcher && cache_data.dates[i].games[j].teams['home'].probablePitcher.fullName) ) {
                  if ( cache_data.dates[i].games[j].teams['away'].probablePitcher && cache_data.dates[i].games[j].teams['away'].probablePitcher.fullName ) {
                    description += cache_data.dates[i].games[j].teams['away'].probablePitcher.fullName
                  } else {
                    description += 'TBD'
                  }
                  description += ' vs. '
                  if ( cache_data.dates[i].games[j].teams['home'].probablePitcher && cache_data.dates[i].games[j].teams['home'].probablePitcher.fullName ) {
                    description += cache_data.dates[i].games[j].teams['home'].probablePitcher.fullName
                  } else {
                    description += 'TBD'
                  }
                  description += '. '
                }

                let gameDate = new Date(cache_data.dates[i].games[j].gameDate)
                let gameHours = 3
                // Handle suspended, TBD, and doubleheaders
                if ( cache_data.dates[i].games[j].status.resumedFrom ) {
                  gameHours = 1
                  if ( cache_data.dates[i].games[j].description ) {
                    description += cache_data.dates[i].games[j].description
                  } else {
                    description += 'Resumption of suspended game.'
                  }
                  gameDate = new Date(cache_data.dates[i].games[j].gameDate)
                  gameDate.setHours(gameDate.getHours()+1)
                } else if ( (cache_data.dates[i].games[j].status.startTimeTBD == true) && (cache_data.dates[i].games[j].doubleHeader == 'Y') && (cache_data.dates[i].games[j].gameNumber == 2) ) {
                  description += 'Start time TBD.'
                  gameDate = new Date(cache_data.dates[i].games[j-1].gameDate)
                  gameDate.setHours(gameDate.getHours()+3)
                } else if ( cache_data.dates[i].games[j].status.startTimeTBD == true ) {
                  continue
                }
                let start = this.convertDateToXMLTV(gameDate)
                gameDate.setHours(gameDate.getHours()+gameHours)
                let stop = this.convertDateToXMLTV(gameDate)

                programs += "\n" + '    <programme channel="' + channelid + '" start="' + start + '" stop="' + stop + '">' + "\n" +
                '      <title lang="en">' + title + '</title>' + "\n" +
                '      <desc lang="en">' + description.trim() + '</desc>' + "\n" +
                '      <category lang="en">Sports</category>' + "\n" +
                '      <icon src="' + icon + '"></icon>' + "\n" +
                '    </programme>'
              }
            }
          }
        }

        var body = '<?xml version="1.0" encoding="UTF-8"?>' + "\n" +
        '<!DOCTYPE tv SYSTEM "xmltv.dd">' + "\n" +
        '  <tv generator-info-name="mlbserver" source-info-name="mlbserver">'
        for (const [key, value] of Object.entries(channels)) {
          body += "\n" + '    <channel id="' + key + '">' + "\n" +
          '      <display-name>' + value.name + '</display-name>' + "\n" +
          '      <icon src="' + value.icon + '"></icon>' + "\n" +
          '    </channel>'
        }
        body += programs + "\n" + '  </tv>'

        return body
      }
    } catch(e) {
      this.log('getGuide error : ' + e.message)
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

  // Get gameday data for a game (play and pitch data)
  async getGamedayData(gamePk) {
    try {
      this.debuglog('getGamedayData')

      let cache_data
      let cache_name = 'g' + gamePk
      let cache_file = path.join(CACHE_DIRECTORY, cache_name+'.json')
      let currentDate = new Date()
      if ( !fs.existsSync(cache_file) || !this.cache || !this.cache.gameday || !this.cache.gameday[cache_name] || !this.cache.gameday[cache_name].gamedayCacheExpiry || (currentDate > new Date(this.cache.gameday[cache_name].gamedayCacheExpiry)) ) {
        let reqObj = {
          url: 'http://statsapi.mlb.com/api/v1.1/game/' + gamePk + '/feed/live',
          headers: {
            'User-agent': USER_AGENT,
            'Origin': 'https://www.milb.com',
            'Accept-Encoding': 'gzip, deflate, br',
            'Content-type': 'application/json'
          },
          gzip: true
        }
        var response = await this.httpGet(reqObj)
        if ( this.isValidJson(response) ) {
          this.debuglog(response)
          cache_data = JSON.parse(response)
          this.save_json_cache_file(cache_name, cache_data)

          // Default cache period is 1 hour from now
          let oneHourFromNow = new Date()
          oneHourFromNow.setHours(oneHourFromNow.getHours()+1)
          let cacheExpiry = oneHourFromNow

          if ( (cache_data.gameData.status.abstractGameState == 'Live') && (cache_data.gameData.status.detailedState.indexOf('Suspended') != 0) ) {
            this.debuglog('setting cache expiry to 5 minutes for live game')
            currentDate.setMinutes(currentDate.getMinutes()+5)
            cacheExpiry = currentDate
          } else {
            let today = this.liveDate()

            if ( cache_data.gameData.datetime.officialDate < today ) {
              this.debuglog('setting cache expiry to forever for past games')
              cacheExpiry = new Date(8640000000000000)
            }
          }

          // finally save the setting
          this.setGamedayCacheExpiry(cache_name, cacheExpiry)
        } else {
          this.log('error : invalid response from url ' + reqObj.url)
        }
      } else {
        this.debuglog('using cached gameday data')
        cache_data = this.readFileToJson(cache_file)
      }
      if (cache_data) {
        return cache_data
      }
    } catch(e) {
      this.log('getGamedayData error : ' + e.message)
    }
  }

  // Get broadcast start timestamp
  async getBroadcastStart(streamURL, gamePk) {
    this.debuglog('getBroadcastStart')
    if ( this.temp_cache && this.temp_cache[gamePk] && this.temp_cache[gamePk].broadcast_start_timestamp ) {
      this.debuglog('using cached broadcast start timestamp')
      return true
    } else {
      let broadcast_start_timestamp
      let url = streamURL.substring(0,(streamURL.length-5)) + '_5472K.m3u8'
      let reqObj = {
        url: url,
        headers: {
          'Origin': 'https://www.milb.com',
          'Referer': 'https://www.milb.com/',
          'User-Agent': USER_AGENT
        }
      }
      var response = await this.httpGet(reqObj)
      var body = response.toString().trim().split('\n')
      for (var i=0; i<body.length; i++) {
        if ( body[i].startsWith('#EXT-X-PROGRAM-DATE-TIME:') ) {
          broadcast_start_timestamp = new Date(body[i].substring(25))
          this.debuglog('Found broadcast start timestamp ' + broadcast_start_timestamp)
          break
        }
      }
      if ( broadcast_start_timestamp ) {
        if ( !this.temp_cache[gamePk] ) {
          this.temp_cache[gamePk] = {}
        }
        this.temp_cache[gamePk].broadcast_start_timestamp = broadcast_start_timestamp
        return true
      } else {
        this.log('Failed to find broadcast start timestamp from ' + url)
        return false
      }
    }
  }

  // Get skip markers into temporary cache
  async getSkipMarkers(gamePk, skip_type, start_inning, start_inning_half, skip_adjust) {
    try {
      this.debuglog('getSkipMarkers')

      if ( skip_adjust != 0 ) this.log('manual adjustment of ' + skip_adjust + ' seconds being applied')

      let skip_markers = []

      // assume the game starts in a break
      let break_start = 0

      // Get the broadcast start time first -- event times will be relative to this
      let broadcast_start_timestamp = this.temp_cache[gamePk].broadcast_start_timestamp
      this.debuglog('getSkipMarkers broadcast start detected as ' + broadcast_start_timestamp)

      if (start_inning == '') {
        start_inning = 0
      }
      if (start_inning_half == '') {
        start_inning_half = 'top'
      }

      let cache_data = await this.getGamedayData(gamePk)

      // make sure we have play data
      if (cache_data && cache_data.liveData && cache_data.liveData.plays && cache_data.liveData.plays.allPlays) {

        // keep track of inning, if skipping inning breaks only
        let previous_inning = 0
        let previous_inning_half = ''

        // calculate total skip time (for fun)
        let total_skip_time = 0

        // Loop through all plays
        for (var i=0; i < cache_data.liveData.plays.allPlays.length; i++) {

          // make sure start inning is valid
          if (start_inning > 0) {
            let last_play_index = cache_data.liveData.plays.allPlays.length - 1
            let final_inning = cache_data.liveData.plays.allPlays[last_play_index].about.inning
            if (start_inning >= final_inning) {
              if (start_inning > final_inning) {
                start_inning = final_inning
                let final_inning_half = json_source['liveData']['plays']['allPlays'][last_play_index]['about']['halfInning']
                if ((start_inning_half == 'bottom') && (final_inning_half == 'top')) {
                  start_inning_half = final_inning_half
                }
              }
            }
          }

          // exit loop after found inning, if not skipping any breaks
          if ((skip_type == 0) && (skip_markers.length == 1)) {
            break
          }

          let current_inning = cache_data.liveData.plays.allPlays[i].about.inning
          let current_inning_half = cache_data.liveData.plays.allPlays[i].about.halfInning
          // make sure we're past our start inning
          if ((current_inning > start_inning) || ((current_inning == start_inning) && ((current_inning_half == start_inning_half) || (current_inning_half == 'bottom')))) {
            // loop through events within each play
            for (var j=0; j < cache_data.liveData.plays.allPlays[i].playEvents.length; j++) {
              // always exclude break types
              if (cache_data.liveData.plays.allPlays[i].playEvents[j].details && cache_data.liveData.plays.allPlays[i].playEvents[j].details.event && BREAK_TYPES.includes(cache_data.liveData.plays.allPlays[i].playEvents[j].details.event)) {
                // if we're in the process of skipping inning breaks, treat the first break type we find as another inning break
                if ((skip_type == 1) && (previous_inning > 0)) {
                  break_start = ((new Date(cache_data.liveData.plays.allPlays[i].playEvents[j].startTime) - broadcast_start_timestamp) / 1000) + EVENT_END_PADDING + skip_adjust
                  previous_inning = 0
                }
                continue
              } else {
                let action_index
                // skip type 1 (breaks) && 2 (idle time) will look at all plays with an endTime
                if ((skip_type <= 2) && cache_data.liveData.plays.allPlays[i].playEvents[j].endTime) {
                  action_index = j
                } else if (skip_type == 3) {
                  // skip type 3 excludes non-action pitches (events that aren't last in the at-bat and don't fall under action types)
                  if ( (j < (cache_data.liveData.plays.allPlays[i].playEvents.length - 1)) && (!cache_data.liveData.plays.allPlays[i].playEvents[j].details || !cache_data.liveData.plays.allPlays[i].playEvents[j].details.event || !ACTION_TYPES.some(v => cache_data.liveData.plays.allPlays[i].playEvents[j].details.event.includes(v))) ) {
                    continue
                  } else {
                    // if the action is associated with another play or the event doesn't have an end time, use the previous event instead
                    if (cache_data.liveData.plays.allPlays[i].playEvents[j].actionPlayId || ((cache_data.liveData.plays.allPlays[i].playEvents[j].endTime === 'undefined') && (j > 0))) {
                      action_index = j - 1
                    } else {
                      action_index = j
                    }
                  }
                }
                if (typeof action_index === 'undefined') {
                  continue
                } else {
                  let break_end = ((new Date(cache_data.liveData.plays.allPlays[i].playEvents[action_index].startTime) - broadcast_start_timestamp) / 1000) + EVENT_START_PADDING + skip_adjust
                  // if the break duration should be greater than than our specified minimum
                  // and if skip type is not 1 (inning breaks) or the inning has changed
                  // then we'll add the skip marker
                  // otherwise we'll ignore it and move on to the next one
                  if ( ((break_end - break_start) >= MINIMUM_BREAK_DURATION) && ((skip_type != 1) || (current_inning != previous_inning) || (current_inning_half != previous_inning_half)) ) {
                    skip_markers.push({'break_start': break_start, 'break_end': break_end})
                    total_skip_time += break_end - break_start
                    previous_inning = current_inning
                    previous_inning_half = current_inning_half
                    // exit loop after found inning, if not skipping breaks
                    if (skip_type == 0) {
                      break
                    }
                  }
                  break_start = ((new Date(cache_data.liveData.plays.allPlays[i].playEvents[action_index].endTime) - broadcast_start_timestamp) / 1000) + EVENT_END_PADDING + skip_adjust
                  // add extra padding for overturned review plays
                  if (cache_data.liveData.plays.allPlays[i].reviewDetails && (cache_data.liveData.plays.allPlays[i].reviewDetails.isOverturned == true)) {
                    break_start += 40
                  }
                }
              }
            }
          }
        }

        this.debuglog('getSkipMarkers found ' + new Date(total_skip_time * 1000).toISOString().substr(11, 8) + ' total skip time')
      }

      this.debuglog('getSkipMarkers skip markers: ' + JSON.stringify(skip_markers))
      this.temp_cache[gamePk].skip_markers = skip_markers

      return true
    } catch(e) {
      this.log('getSkipMarkers error : ' + e.message)
    }
  }

}

module.exports = sessionClass