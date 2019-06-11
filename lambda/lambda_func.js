const axios = require('axios');
const moment = require('moment');
const aws = require('aws-sdk');

exports.lambda_handler = async (event, context) => {
  if (!event || !event.Body) {
    return handleScheduledExecution();
  }
    const [ action, route, direction, place ] = event.Body.split('%2C');
    
    if(action === 'stop' || action ==='end') {
      removeSubscription(event.From.slice(3));
      return `<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response><Message>\nAll done! Until next time.</Message></Response>`;
    }

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

    const matchingStop = await getMatchingStop(route, place);

    switch(action.trim().toLowerCase()) {
      case 'start':
        subscribe(event.From.slice(3), route, directionID, matchingStop);
        break;
    }
    let retStr = '';
    if (matchingStop && matchingStop.id) {
      const departuresStr = await getDeparturesForStopAndRoute(matchingStop, route, directionID);
      retStr = buildSMSWithDepartures(matchingStop, route, departuresStr);
    } else {
      retStr = buildFailureSMS();
    }
    return retStr;
};

const buildAndSendDepartureText = async (phoneNumber, route, stop, directionID) => {
  const accountSid = process.env.TWILIO_ACCT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const client = require('twilio')(accountSid, authToken);

  const departuresStr = await getDeparturesForStopAndRoute(stop, route, directionID);
  const retStr = `Next 3 departures for the ${ route } from ${ stop.name }:\n${ departuresStr }`;
  console.log(retStr);
  client.messages.create({body: retStr, from: '6176572092', to: phoneNumber})
  return retStr;
};

const buildSMSWithDepartures = (matchingStop, route, departuresStr, phoneNumber) => {
  return `<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response><Message>\nNext 3 departures for the ${ route } from ${ matchingStop.name }:\n${ departuresStr }</Message></Response>`;
};

const buildFailureSMS = () => `<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response><Message>\nUnable to find the stop you requested</Message></Response>`;

const getDeparturesForStopAndRoute = async (stop, route, directionID) => {
  const departuresURL = `https://api-v3.mbta.com/predictions/?filter[stop]=${ stop.id }&filter[route]=${ route }&filter[direction_id]=${ directionID }&sort=arrival_time`;
  const res = await axios.get(departuresURL);
  const departures = parseDepartures(res.data.data);
  const tripsWithDestinations = await getDestinationsForTrips(departures.map(departure => departure.tripID));
  const departuresStr = departures.reduce((acc, curr) => acc + `${ tripsWithDestinations.filter(trip => trip.id === curr.tripID)[0].destination }: ${curr.time}, ${curr.timeUntil}\n`, '');

  return departuresStr;
};

const getDestinationsForTrips = async (tripIDs) => {
  const pendingTrips = tripIDs.map(id => axios.get(`https://api-v3.mbta.com/trips/${ id }`));
  const resolvedTrips = await Promise.all(pendingTrips);
  const tripsWithDestinations = resolvedTrips.map(trip => ({ id: trip.data.data.id, destination: trip.data.data.attributes.headsign}));
  return tripsWithDestinations;
};

const getMatchingStop = async (userRoute, userPlace) => {
  const stops = await axios.get(`https://api-v3.mbta.com/stops?filter[route]=${ userRoute }`);
  const matchingStop =  stops.data.data.map(s => ({ name: s.attributes.name, id: s.id })).filter(s => {
    const lowerStopName = s.name.toLowerCase().split(' ').join('');
    const lowerInput = userPlace.toLowerCase().split(' ').join('');
    return lowerStopName.includes(lowerInput);
  })[0];
return matchingStop
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

exports.test2 = () => {
  return buildAndSendDepartureText('7817333094', 'Red', {id: 'place-pktrm', name: 'Park Street'}, '1');
};

const subscribe = async (userID, route, directionID, matchingStop) => {
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

const removeSubscription = async (userID) => {
  console.log('stopping');
  const dynamo = new aws.DynamoDB.DocumentClient();
  const subscriptionParams = {
    Key: {
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

const handleScheduledExecution = async () => {
  const dynamo = new aws.DynamoDB.DocumentClient();
  const subscriptionParams = {
    TableName: process.env.SUBSCRIPTIONS_TABLE
  }
  try {
    const res = await dynamo.scan(subscriptionParams).promise();    
    res.Items.forEach((subscription) => {
      const { phone_number, route, stop_name, stop_id, direction_id } = subscription;
      buildAndSendDepartureText(phone_number, route, { name: stop_name, id: stop_id }, direction_id);
    });
  } catch(e) {
    console.log(e);
  }
};