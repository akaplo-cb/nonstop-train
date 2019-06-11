const axios = require('axios');
const moment = require('moment');
const aws = require('aws-sdk');

exports.lambda_handler = async (event, context) => {
    const [ action, route, direction, place ] = event.Body.split('%2C');
    console.log(action, route, direction, place);
    let directionID = 0;

    switch (direction.trim().charAt(0).toLowerCase()) {
      case 'n':
        directionID = 1;
        break;
      
      case 'e':
        directionID = 1;
        break;
      
      case 's':
        directionID = 0;
        break;
      
      case 'w':
        directionID = 0;
        break;
      
      default: break;
    }

    const stops = await axios.get(`https://api-v3.mbta.com/stops?filter[route]=${ route }`);
    const matchingStop = stops.data.data.map(s => ({ name: s.attributes.name, id: s.id })).filter(s => {
      const lowerStopName = s.name.toLowerCase().split(' ').join('');
      const lowerInput = place.toLowerCase().split(' ').join('');
      return lowerStopName.includes(lowerInput);
    })[0];

    switch(action.trim().toLowerCase()) {
      case 'start':
        subscribe(event.From, route, directionID, matchingStop);
        break;
      case 'end':
          removeSubscription(event.From, route, directionID, matchingStop);
          break;
    }
    let retStr = '';
    if (matchingStop && matchingStop.id) {
      const departuresURL = `https://api-v3.mbta.com/predictions/?filter[stop]=${ matchingStop.id }&filter[route]=${ route }&filter[direction_id]=${ directionID }&sort=arrival_time`;
      const res = await axios.get(departuresURL);
      const parsed = parseDepartures(res.data.data);
      const trips = parsed.map(d => axios.get(`https://api-v3.mbta.com/trips/${ d.tripID }`));
      let y = await Promise.all(trips);
      y = y.map(z => ({ id: z.data.data.id, destination: z.data.data.attributes.headsign}));
      console.log(y)
      const departuresStr = parsed.reduce((acc, curr) => acc + `${ y.filter(z => z.id === curr.tripID)[0].destination }: ${curr.time}, ${curr.timeUntil}\n`, '');
      retStr = `<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response><Message>\nNext 3 departures for the ${ route } from ${ matchingStop.name }:\n${ departuresStr }</Message></Response>`;
    } else {
      retStr = `<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response><Message>\nUnable to find the stop you requested</Message></Response>`;
    }
    console.log(retStr);
    return retStr;
};

const parseDepartures =  (data) => {
  const departures = data.map(d => {
    let timeToUse = moment.parseZone(d.attributes.arrival_time);
    if (!timeToUse && !d.attributes.departure_time) {
      return {};
    }
    timeToUse = moment.parseZone(d.attributes.departure_time);
    return {
      timeUntil: timeToUse.fromNow(),
      time: timeToUse.format('hh:mm'),
      tripID: d.relationships.trip.data.id
    };
  });
  return departures.slice(0, 3);
};

exports.test = () => {
  return exports.lambda_handler({
    "ToCountry": "US",
    "ToState": "MA",
    "SmsMessageSid": "SMea9b73e440bff357b4ddd2b121aee2ee",
    "NumMedia": "0",
    "ToCity": "QUINCY",
    "FromZip": "02132",
    "SmsSid": "SMea9b73e440bff357b4ddd2b121aee2ee",
    "FromState": "MA",
    "SmsStatus": "received",
    "FromCity": "WEST+ROXBURY",
    "Body": "start%2CBlue%2CE%2Cairport",
    "FromCountry": "US",
    "To": "%2B16176572092",
    "ToZip": "02169",
    "NumSegments": "1",
    "MessageSid": "SMea9b73e440bff357b4ddd2b121aee2ee",
    "AccountSid": "AC3c5a50d91095d5fa4d8c1844cd8cc931",
    "From": "%2B17817333094",
    "ApiVersion": "2010-04-01"
  });
};

const subscribe = async (userID, route, directionID, matchingStop) => {
  console.log(userID, route, directionID, matchingStop);
  const dynamo = new aws.DynamoDB.DocumentClient();
  const subscriptionParams = {
    Item: {
      'phone_number': userID,
      'direction_id': directionID,
      route,
      'stop_id': matchingStop.id,
      'stop_name': matchingStop.name
    },
    TableName: process.env.SUBSCRIPTIONS_TABLE
  }
  try {
    const dynamoPromise = await dynamo.put(subscriptionParams).promise();    
    console.log(dynamoPromise)
  } catch(e) {
    console.log(e);
  }
};

const removeSubscription = (userID, route, directionID, matchingStop) => {
  const dynamo = new aws.DynamoDB.DocumentClient();
  const subscriptionParams = {
    Item: {
      'phone_number': userID
    },
    TableName: process.env.SUBSCRIPTIONS_TABLE
  }
  try {
    const dynamoPromise = await dynamo.delete(subscriptionParams).promise();    
    console.log(dynamoPromise)
  } catch(e) {
    console.log(e);
  }
};