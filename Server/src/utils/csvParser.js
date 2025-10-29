const CSVParser = {
    parse: (csvString) => {
        let schema = [];

        const lines = csvString.split('\n').filter(line => line.trim() !== '');
        const headers = lines[0].split(',').map(header => header.trim());

        const data = lines.slice(1).map(line => {
            const values = line.split(',').map(value => value.trim());
            const entry = {};
            headers.forEach((header, index) => {
                entry[header] = values[index] || '';
            });
            return entry;
        });
        return data;
    }
};

export default CSVParser;