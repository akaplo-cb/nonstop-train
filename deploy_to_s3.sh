filename=nonstop-train.latest.zip
cd lambda
zip -r ${filename} .
aws lambda update-function-code --function-name aaron-hackathon-31 --zip-file fileb://${filename}